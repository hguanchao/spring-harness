import type { RunTurnOptions } from '../../agent/driver.js';
import {
  appendableMessage,
  flushWireAttachments,
  loadCompaction,
  openCompactedSession,
  projectContext,
  pushSessionMessage,
  wireFromMessages,
  type CompactionEvent,
  type WireState,
} from './compact.js';
import type { AgentListener, SubagentEvent } from './events.js';
import { TouchMemory, touchInstructionBlock } from './memory.js';
import { PLAN_MODE_SERVICE, type PlanModeSeam } from '../services.js';
import { buildSystemPrompt, contextTailMessage, isContextTailMessage, isSessionStateMessage, sessionStateMessage } from './prompt.js';
import { hashMessage, hashText, observePrefix, type PrefixSnapshot } from './prefix-tracker.js';
import { runToolBatch } from './tool-run.js';
import { CacheMissTracker, describeCacheMiss } from '../../llm/cache-stats.js';
import type { ChatMessage, TokenUsage } from '../../llm/client.js';
import { EMPTY_TODO, MCP_SERVICE, SCHEDULER_SERVICE, SESSION_SERVICE, SKILLS_SERVICE, SUBAGENT_SERVICE, TODO_SERVICE, todoEventData, type McpService, type SchedulerService, type SessionService, type SkillService, type SubagentCatalog, type TodoService } from '../services.js';
import { EMPTY_PLUGIN_SERVICES, type PluginServices } from '../types.js';
import type { JobRecord } from '../../runtime/scheduler.js';
import { jobNotificationText } from '../../runtime/scheduler.js';
import { WorktreeStore } from './worktrees.js';
import { shellArgv } from '../../sandbox/shell-bin.js';
import { errorMessage } from '../../util.js';
import { foldSessionState, sessionEventData } from '../../session/fold.js';
import { lastAssistantMessage } from '../../session/query.js';
import { closeInterruptedTurn } from '../../session/repair.js';
import type { SessionMessage, SessionRecord } from '../../session/types.js';
import type { ToolRegistry } from '../../tools/registry.js';
import { FileObservation } from '../../tools/observe.js';
import { toolDenied } from '../../tools/pipeline.js';
import { SUBAGENT_CONCURRENCY, type ToolContext, type ToolResult } from '../../tools/types.js';
import { existsSync } from 'node:fs';

/**
 * 步数上限之前留出的收束窗口，只用于配了 maxTurns 的子会话。
 *
 * 模型看不到循环计数。不在这里说，它会把「继续补全」执行到被切断。
 * 窗口内仍可补工具调用；最后一步不再给工具。上限本身不足一窗时，从第一步就提醒。
 */
const WIND_DOWN_STEPS = 4;

function windDownNote(limit: number): string {
  const left = Math.min(WIND_DOWN_STEPS, limit);
  return `[step budget — ${left} step${left === 1 ? '' : 's'} remain, then this turn ends. Stop opening new work. `
    + 'Write the report now: what you established or changed, the exact paths and identifiers, and what you did not finish. '
    + 'One more tool call is only for a fact the report cannot do without.]';
}

/**
 * 把子代理定义里的工具名单收成实际可用集合。
 *
 * `*` 按当前工具表展开，但委托工具不跟着进去：子代理默认不能再派生子代理，
 * 深度预算是第二道，工具集是第一道。点名的工具原样保留（含委托工具），
 * 嵌套只在定义明确授权、且深度预算允许时成立。
 */
/**
 * 子会话的可用工具集。导出仅供测试：行为在 spawn 路径上被 runChild 消费。
 */
export function resolveChildTools(registry: ToolRegistry, declared: readonly string[]): Set<string> {
  const base = declared.includes('*')
    ? registry.generalNames()
    : new Set(declared.filter((name) => registry.find(name)));
  if (declared.includes('*')) {
    base.delete('task');
    base.delete('send_subagent_message');
    // todo 清单是同进程共享的 TodoService 实例：子代理写入会顶掉根会话正在看的
    // 面板，todo 事件又分别落进两个会话文件，fold 回来互相覆盖。子代理的产出物
    // 是最终报告，不该维护跨会话清单。显式点名的自定义定义不受此限——那是明确选择。
    base.delete('todo');
  }
  return base;
}

/** 预算用掉多少就打一条 warn：留出「收尾并交付已有成果」的余地。 */
const BUDGET_WARN_RATIO = 0.8;

/**
 * 根会话当前坐着的代理。
 *
 * 名字来自会话里最后一条 `agent` 事件。空名字是「切回默认」。
 * 定义按调用时重读：用户刚丢进 `.sph/agents/` 的文件，下一轮就生效。
 */
function seatedAgent(options: RunTurnOptions): { tools: ReadonlySet<string>; prompt: string } | undefined {
  const records = options.session.readAll();
  let name = '';
  let seen = false;
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (!record || record.type !== 'event' || record.kind !== 'agent') continue;
    const value = record.data.name;
    if (typeof value !== 'string') continue;
    name = value;
    seen = true;
    break;
  }
  if (!seen || name === '') return undefined;
  const services = options.services ?? EMPTY_PLUGIN_SERVICES;
  return services.get<SubagentCatalog>(SUBAGENT_SERVICE)?.seat(name);
}

/**
 * 活跃子代理 session id（进程级）：resume 校验「不在运行中」用。必须跨 runTurn 实例
 * 共享——后台子代理会活过发起它的那一轮，按轮次建的集合看不见它们。
 */
const activeSubagentSessions = new Set<string>();

/**
 * 事件 id 用进程内单调序号。
 * 旧实现用 `Date.now()`：同一毫秒内连续发出多个 ask/thinking_start 事件会撞号，
 * 消费端（TUI）按 id 配对 start/end 时会串台。
 */
let eventSeq = 0;
function nextEventId(prefix: string): string {
  return `${prefix}-${++eventSeq}`;
}

/** 从后往前找最近一条被标记的 user 消息。尾部快照只在文本变了才再追加一条。 */
function latestTagged(rows: readonly SessionMessage[], isTagged: (content: string) => boolean): string | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row && row.role === 'user' && isTagged(row.content)) return row.content;
  }
  return undefined;
}

export type { AgentDriver, RunTurnOptions } from '../../agent/driver.js';

/** 极简计数信号量：并行 subagent 超过上限时排队。 */
class Semaphore {
  private waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.waiters.length === 0 && this.active < this.limit) {
      this.active++;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.active++;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.active--;
    this.waiters.shift()?.();
  }

  private active = 0;
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('tool arguments must be an object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * 没装插件（测试）才用内核里的折叠和通知文案。
 * 会话工厂和任务板不在这里造：正式启动缺服务就失败，测试必须自己传入。
 */
function bundled<T>(services: PluginServices, value: T): T | undefined {
  return services === EMPTY_PLUGIN_SERVICES ? value : undefined;
}

/** 超窗只认错误名。循环不 import 模型插件，也不用 instanceof 绑死某一个类。 */
function isContextOverflow(error: unknown): boolean {
  return error instanceof Error && error.name === 'ContextOverflowError';
}

export async function runTurn(options: RunTurnOptions): Promise<void> {
  const depth = options.depth ?? 0;
  const maxSubagentDepth = Math.max(0, Math.floor(options.maxSubagentDepth ?? 1));
  const registry = options.tools;
  const services = options.services ?? EMPTY_PLUGIN_SERVICES;
  const sessionApi = services.get<SessionService>(SESSION_SERVICE);
  const sessions = options.sessions ?? sessionApi?.factory;
  if (!sessions) throw new Error('sph-session is not loaded');
  // 压缩会换成新会话。闭包必须看到这份绑定，不能捕获 options.session。
  let active = options.session;
  const fold = sessionApi?.fold ?? bundled(services, foldSessionState);
  const events = sessionApi?.events ?? bundled(services, sessionEventData);
  const closeTurn = sessionApi?.closeInterruptedTurn ?? bundled(services, closeInterruptedTurn);
  const lastAssistant = sessionApi?.lastAssistant ?? bundled(services, lastAssistantMessage);
  const notify = services.get<SchedulerService>(SCHEDULER_SERVICE)?.notificationText ?? bundled(services, jobNotificationText);
  // 测试不装插件，直接扫技能目录。正式启动装了插件之后，关掉 sph-skills 就是空目录，
  // 不再回落到循环自己的那份扫描。
  const skills = services.get<SkillService>(SKILLS_SERVICE)?.scan(options.workspaceRoot) ?? { catalog: [], warnings: [] };
  for (const warning of skills.warnings) options.listener?.({ type: 'status', text: warning });
  const jobs = options.jobs ?? services.get<SchedulerService>(SCHEDULER_SERVICE)?.create();
  if (!jobs) throw new Error('sph-schedule is not loaded');
  const mcp = services.get<McpService>(MCP_SERVICE);
  // todo 与 mcp 同一套缺席语义：插件被禁用时清单不可用。工具表里也不会有 todo 工具，
  // 所以这里缺省成「空清单 + 不写事件」不会让任何核心路径拿到 undefined 而崩。
  const todos = options.todos ?? services.get<TodoService>(TODO_SERVICE) ?? EMPTY_TODO;
  const memory = options.memory ?? new TouchMemory(options.workspaceRoot);
  const worktrees = options.worktrees ?? new WorktreeStore();

  // 系统提示在一轮内冻结，而且一轮和下一轮也是同一份：它是前缀的 message 0。
  // 日期、目录、目标这些会变的内容在尾部消息里，变了只追加，不改写这一段。
  // 计划模式的进出由工具结果和执行层负责，不靠改系统提示。
  // 根会话选了代理时，工具和角色段都按那份定义收。子会话仍用派生时传入的集合。
  // 没选、定义丢了、插件没装，都退回全工具，不让一条坏记录把会话锁死。
  const seated = depth === 0 ? seatedAgent(options) : undefined;
  const sessionTools = options.allowedTools ?? seated?.tools;
  const rolePrompt = options.subagentPrompt ?? seated?.prompt;
  const promptInput = {
    child: depth > 0,
    workspaceRoot: options.workspaceRoot,
    model: options.model,
    sandbox: options.sandbox.status.mode,
    skills: skills.catalog,
    mcpTools: mcp?.listTools() ?? [],
    // 清单只随配置变化、不随连接状态变化（见 prompt.ts 的 lazyMcpServers 注释）。
    lazyMcpServers: (mcp?.listServers() ?? []).filter((server) => server.lazy).map((server) => server.name),
    // 只把本次真正可用的工具写进提示词：受限会话（如只读子代理）里，不可用工具的段落
    // 整段消失，而不是留下一句指向不存在工具的指令。`allowedTools` 为空时过去会放行
    // 全部段落——那会让被插件禁用/装载失败的工具（如 sph-mcp 没装时的 `mcp`）也留一段
    // 指令，所以这里按**工具表里真实存在的名字**收口。
    allowedTools: sessionTools ?? new Set(registry.list().map((tool) => tool.name)),
    toolPrompts: registry.list().flatMap((tool) => {
      const text = tool.prompt ?? tool.description;
      return text ? [{ tool: tool.name, text }] : [];
    }),
  };
  const systemBody = buildSystemPrompt(promptInput);
  // 子代理角色段追加在末尾：主提示词在前、角色约束在后。父会话不带这段，前缀互不影响。
  const systemPrompt = rolePrompt ? `${systemBody}\n\n${rolePrompt}` : systemBody;
  const contextText = contextTailMessage(promptInput);
  // token 预算：整棵代理树的累计量（自己的 usage + 各子代理 end 事件里的 tokens）。
  const budget = Math.max(0, Math.floor(options.maxSessionTokens ?? 0));
  const budgetWarnAt = budget > 0 ? Math.floor(budget * BUDGET_WARN_RATIO) : 0;
  let sessionTokens = 0;
  if (budget > 0) {
    if (!fold) throw new Error('sph-session is not loaded');
    sessionTokens = fold(active.readAll()).tokensUsed;
  }
  let budgetWarned = false;
  /**
   * 记账。
   *
   * 警告放在**扣费之后**而不是步首的检查里：越过 80% 的那一步通常在步首检查时还没到阈值，
   * 等下一步再查就正好被「超限即中止」抢先，那条提醒永远不会发出。提醒的用处正是
   * 让用户/模型在这轮还能收尾并交付已有成果。
   */
  const chargeTokens = (prompt: number, completion: number): void => {
    sessionTokens += Math.max(0, prompt) + Math.max(0, completion);
    if (budget > 0 && !budgetWarned && sessionTokens >= budgetWarnAt) {
      budgetWarned = true;
      options.listener?.({
        type: 'status',
        level: 'warn',
        text: `Session token budget ${Math.round((sessionTokens / budget) * 100)}% used (${sessionTokens}/${budget}).`,
      });
    }
  };
  /** 超预算就在发起下一次请求**之前**停：已经花掉的钱换不回，但下一笔可以不花。 */
  const assertBudget = (): void => {
    if (budget > 0 && sessionTokens >= budget) {
      throw new Error(
        `session token budget exhausted: ${sessionTokens} >= max_session_tokens ${budget}. `
        + 'Raise max_session_tokens, or start a new session (`--new`).',
      );
    }
  };

  // 会话镜像：turn 内所有投影走内存，避免每个 step 重读 JSONL。压缩换会话时整表替换。
  let mirror: SessionMessage[] = active.readMessages();
  if (!closeTurn) throw new Error('sph-session is not loaded');
  closeTurn(active, mirror);
  // 还没落盘的行。取消发生在第一次模型活动之前时，这些行不进 JSONL，输入框能把原文拿回去。
  const pendingRows = new Set<SessionMessage>();
  const queueTail = (row: SessionMessage): void => {
    mirror.push(row);
    pendingRows.add(row);
  };
  queueTail({
    type: 'message',
    ts: new Date().toISOString(),
    role: 'user',
    content: options.prompt,
    images: options.userImages,
    documents: options.userDocuments,
    attachments: options.attachments,
  });
  // 环境和跨轮次状态都在尾部。与上一条逐字相同就不再追加：重复快照只涨上下文，不提供新信息。
  if (latestTagged(mirror, isContextTailMessage) !== contextText) {
    queueTail({ type: 'message', ts: new Date().toISOString(), role: 'user', content: contextText });
  }
  const stateText = sessionStateMessage(
    options.goal,
    options.lastFailure,
    options.planMode?.active === true,
    services.get<PlanModeSeam>(PLAN_MODE_SERVICE),
  );
  if (latestTagged(mirror, isSessionStateMessage) !== stateText) {
    queueTail({ type: 'message', ts: new Date().toISOString(), role: 'user', content: stateText });
  }
  let turnPersisted = false;
  const persistTurnStart = (): void => {
    if (turnPersisted) return;
    turnPersisted = true;
    for (const row of pendingRows) active.appendMessage(appendableMessage(row));
    pendingRows.clear();
    active.appendEvent('turn_start', { depth, sandbox: options.sandbox.status.mode });
  };
  let compaction: CompactionEvent | undefined = loadCompaction(active);
  let wire: WireState = wireFromMessages(mirror, compaction);
  let lastUsage: TokenUsage | undefined;
  // stub 级压缩的冻结边界（session 坐标）：一旦生效就不再随轮次前移，摘要落地时重置。
  let stubFromSession: number | undefined;
  /** lastUsage 覆盖到的镜像位置：之后追加的消息没算进那份 prompt，估算时要补上。 */
  let usageAnchor = mirror.length;
  /**
   * 提示缓存命中观测。一次 turn 一个实例：它在内存里握着「上一轮请求」的基线，
   * 跨 turn 的累计由 `foldSessionState` 按同样口径重放会话事件得出。
   */
  const cacheTracker = new CacheMissTracker();
  /** 上一轮请求的前缀快照：分段变更观测的基线（见 prefix-tracker.ts）。compact 后与 cacheTracker 一起重置。 */
  let prefixPrev: PrefixSnapshot | undefined;
  /** todo 上次落盘的样子：只有真的变了才写事件，避免每步都往 JSONL 塞一份重复快照。 */
  let todoSnapshot = JSON.stringify(todos.list());
  const appendMessage = (message: Omit<SessionMessage, 'type' | 'ts'>): void => {
    active.appendMessage(message);
    const row: SessionMessage = { type: 'message', ts: new Date().toISOString(), ...message };
    mirror.push(row);
    pushSessionMessage(wire, row);
  };

  const subagentSlots = new Semaphore(SUBAGENT_CONCURRENCY);
  /**
   * 子代理事件摘要落盘的上限：最终报告可以很长，完整版在子会话 JSONL 里，
   * 主会话事件只留足够回放块展开阅读的头部。
   */
  const SUBAGENT_SUMMARY_LIMIT = 2000;

  const runChild = async (input: {
    prompt: string;
    agent: string;
    tools: readonly string[];
    systemPrompt: string;
    signal?: AbortSignal;
    description?: string;
    mode: 'foreground' | 'background';
    toolCallId?: string;
    /** 续接的源子代理会话 id；源消息复制进新会话。 */
    resumeFrom?: string;
    /** worktree：在隔离 git 工作树里跑。 */
    isolation?: 'none' | 'worktree';
    /** 后台任务的 record：子会话创建后回写 subagentSessionId 供 resume / send 寻址。 */
    jobRecord?: JobRecord;
  }): Promise<string> => {
    // resume 校验：源必须已完成、同类型。源子代理的 start 事件落在
    // 父会话文件里（childSessionId 关联），childType 与 worktree 从那里读。
    let sourceRecords: SessionRecord[] = [];
    let resumedWorktree: string | undefined;
    if (input.resumeFrom !== undefined) {
      if (activeSubagentSessions.has(input.resumeFrom)) {
        throw new Error(`resume_from: subagent ${input.resumeFrom} is still running`);
      }
      sourceRecords = sessions.open(active.dir, input.resumeFrom).readAll();
      if (sourceRecords.length === 0) {
        throw new Error(`resume_from: subagent session ${input.resumeFrom} not found`);
      }
      const starts = active
        .readAll()
        .filter(
          (record) =>
            record.type === 'event'
            && record.kind === 'subagent'
            && record.data.phase === 'start'
            && record.data.childSessionId === input.resumeFrom,
        );
      const last = starts.at(-1);
      if (last && last.type === 'event') {
        if (last.data.childType !== undefined && last.data.childType !== input.agent) {
          throw new Error(
            `resume_from: source agent ${String(last.data.childType)} does not match requested ${input.agent}`,
          );
        }
        if (typeof last.data.worktree === 'string') resumedWorktree = last.data.worktree;
      }
    }

    // workspace 决策：resume 沿用源会话的工作树（仍在时）；isolation
    // worktree 在下方新建。树建在 workspace 内——Windows ACL 写授权与 bwrap bind 都按
    // workspace root 授予，放外面子代理写不进。
    let childWorkspaceRoot = options.workspaceRoot;
    if (resumedWorktree !== undefined && existsSync(resumedWorktree)) {
      childWorkspaceRoot = resumedWorktree;
    }

    let childSession = sessions.create(active.dir, childWorkspaceRoot, false);
    const subId = nextEventId('sub');
    const startedAt = Date.now();
    activeSubagentSessions.add(childSession.id);
    if (input.jobRecord) input.jobRecord.subagentSessionId = childSession.id;
    if (input.resumeFrom !== undefined) {
      // 续接：源消息（含工具往来）与 compaction 事件复制进新会话——runTurn 从会话
      // 文件 seed 镜像，子代理自然带上完整上下文。其余事件（subagent/todo/usage）
      // 属于源会话的历史，不复制：resume 的是对话，不是事件流。
      for (const record of sourceRecords) {
        if (record.type === 'message' || (record.type === 'event' && record.kind === 'compaction')) {
          childSession.append(record);
        }
      }
    }
    // isolation worktree：从 HEAD 派生 sph/<id> 分支的隔离工作树（
    // 解析失败即 spawn 失败，不静默降级成共享工作区）。
    let childWorktree: string | undefined;
    if (input.isolation === 'worktree' && input.resumeFrom === undefined) {
      const created = worktrees.create(options.workspaceRoot, childSession.id);
      childWorkspaceRoot = created.path;
      childWorktree = created.path;
    }
    // 后台子代理注册收件箱：仍在跑时父级/模型才能投递消息。foreground 阻塞父级，
    // 天然不可寻址，不注册。
    const childInbox = {
      queue: [] as string[],
      push(text: string): void {
        this.queue.push(text);
      },
      drain(): string[] {
        const out = this.queue;
        this.queue = [];
        return out;
      },
    };
    if (input.mode === 'background') jobs.attachInbox(childSession.id, childInbox);

    const description = input.description ?? input.prompt.slice(0, 60);
    const subagentStart = {
      id: subId,
      description,
      mode: input.mode,
      childType: input.agent,
      childSessionId: childSession.id,
      ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
      ...(childWorktree === undefined ? {} : { worktree: childWorktree }),
    };
    options.listener?.({ type: 'subagent_start', ...subagentStart });
    active.appendEvent('subagent', { phase: 'start', ...subagentStart });
    // 子事件封进 subagent_event：主流程的步骤块从此只属于主代理，TUI 按 id 归位子活动。
    // usage / ask 是全局语义（用量计数、审批提示），保持直通；done 由 subagent_end 表达。
    // usage 同时按子代理累计——subagent_end 要带出该子代理自己的 token 消耗量。
    const childUsage = { promptTokens: 0, completionTokens: 0 };
    const childListener: AgentListener = (event) => {
      // 子代理自己的压缩不能把界面的当前会话换成子会话。只把子会话句柄追到新文件。
      if (event.type === 'session_fork') {
        const previousId = childSession.id;
        activeSubagentSessions.delete(previousId);
        if (input.mode === 'background') {
          jobs.detachInbox(previousId);
          jobs.attachInbox(event.sessionId, childInbox);
        }
        childSession = sessions.open(childSession.dir, event.sessionId);
        activeSubagentSessions.add(childSession.id);
        if (input.jobRecord) input.jobRecord.subagentSessionId = childSession.id;
        return;
      }
      if (event.type === 'usage') {
        childUsage.promptTokens += event.promptTokens;
        childUsage.completionTokens += event.completionTokens;
        options.listener?.(event);
        options.listener?.({
          type: 'subagent_event',
          id: subId,
          event: {
            type: 'usage',
            promptTokens: event.promptTokens,
            completionTokens: event.completionTokens,
            ...(event.costUsd === undefined ? {} : { costUsd: event.costUsd }),
          },
        });
        return;
      }
      if (event.type === 'ask') {
        options.listener?.(event);
        return;
      }
      if (event.type === 'done') return;
      // 孙代理的 subagent_start/end 也从这里封进 subagent_event（消费端按类型自行取舍：
      // TUI 把孙活动并进子代理的聚合计数，不单开块）。
      options.listener?.({ type: 'subagent_event', id: subId, event: event as SubagentEvent });
    };

    const allowed = resolveChildTools(registry, input.tools);
    let outcome: { ok: boolean; summary: string } = { ok: true, summary: '' };
    try {
      await runTurn({
        prompt: input.prompt,
        workspaceRoot: childWorkspaceRoot,
        client: options.client,
        model: options.model,
        session: childSession,
        tools: registry,
        sessions,
        sandbox: options.sandbox,
        approver: options.subagentApprover ?? options.approver,
        contextWindow: options.contextWindow,
        listener: childListener,
        signal: input.signal ?? options.signal,
        services,
        todos,
        jobs,
        memory,
        depth: depth + 1,
        maxSubagentDepth,
        maxTurns: options.maxTurns,
        allowedTools: allowed,
        worktrees,
        subagentPrompt: input.systemPrompt,
        ...(input.mode === 'background' ? { inbox: childInbox } : {}),
      });
      const childMessages = childSession.readMessages();
      const last = lastAssistant?.(childMessages);
      // 到顶那一步往往只有工具调用、正文为空。报告取最后一条非空正文，而不是这条空壳。
      let written = '';
      for (let i = childMessages.length - 1; i >= 0; i--) {
        const row = childMessages[i];
        if (row && row.role === 'assistant' && row.content.trim() !== '') {
          written = row.content;
          break;
        }
      }
      const footer = `[subagent session: ${childSession.id} — continue with task(resume_from: "${childSession.id}")]`;
      const stoppedAtLimit = childSession.readAll().some((record) =>
        record.type === 'event' && record.kind === 'turn_end' && record.data.finishReason === 'step_limit');
      // 到顶是未完成：正文仍交回，但工具结果必须失败，父代理才不会把半份当成结论。
      // 会话号放在发现前面，长报告被截断时续接入口还在。
      if (stoppedAtLimit) {
        const findings = written || '(no findings written)';
        const limit = options.maxTurns;
        throw new Error(
          `Stopped at the ${limit}-step limit before the task was finished.\n${footer}\n\nFindings so far:\n${findings}`,
        );
      }
      outcome = { ok: true, summary: last?.content || '(subagent produced no assistant text)' };
      return `${outcome.summary}\n\n${footer}`;
    } catch (error) {
      outcome = { ok: false, summary: errorMessage(error) };
      throw error;
    } finally {
      // start/end 成对发出、成对落盘：中途崩溃最多留下没有 end 的块，恢复端按 interrupted 呈现。
      const durationMs = Math.max(0, Date.now() - startedAt);
      const tokens = childUsage.promptTokens + childUsage.completionTokens;
      const lifecycle = {
        ...(input.resumeFrom === undefined ? {} : { resumedFrom: input.resumeFrom }),
        ...(childWorktree === undefined ? {} : { worktree: childWorktree }),
      };
      options.listener?.({
        type: 'subagent_end',
        id: subId,
        ok: outcome.ok,
        durationMs,
        summary: outcome.summary,
        tokens,
        ...lifecycle,
      });
      active.appendEvent('subagent', {
        phase: 'end',
        id: subId,
        ok: outcome.ok,
        durationMs,
        tokens,
        summary: outcome.summary.slice(0, SUBAGENT_SUMMARY_LIMIT),
        ...lifecycle,
      });
      jobs.detachInbox(childSession.id);
      activeSubagentSessions.delete(childSession.id);
    }
  };

  const hooks = options.hooks ?? [];
  const runTurnEnd = async (finishReason?: string): Promise<void> => {
    for (const hook of hooks) {
      if (!hook.turnEnd) continue;
      try {
        await hook.turnEnd({ finishReason });
      } catch (error) {
        options.listener?.({ type: 'status', level: 'warn', text: `turnEnd hook: ${errorMessage(error)}` });
      }
    }
  };
  const observation = new FileObservation();
  const ctx: ToolContext = {
    workspaceRoot: options.workspaceRoot,
    sandboxMode: options.sandbox.status.mode,
    signal: options.signal,
    skills: skills.catalog,
    todos,
    jobs,
    services,
    async runShell(command, timeoutMs, kind) {
      return options.sandbox.run({
        ...shellArgv(command, kind),
        cwd: options.workspaceRoot,
        timeoutMs,
        signal: options.signal,
      });
    },
    async approve(tool, detail) {
      options.listener?.({ type: 'ask', id: nextEventId('ask'), tool, detail });
      return options.approver.decide({ tool, command: detail });
    },
    async askUser(prompt) {
      options.listener?.({ type: 'ask', id: nextEventId('ask'), tool: 'ask_user', detail: prompt });
      return options.approver.ask?.(prompt) ?? '';
    },
    sendToSubagent(id, text) {
      return jobs.sendToSubagent(id, text);
    },
    planMode: options.planMode,
    sessionDir: active.dir,
    sessionId: active.id,
    setPlanMode: options.planMode
      ? (enabled: boolean) => {
          if (!options.planMode || options.planMode.active === enabled) return;
          options.planMode.active = enabled;
          if (!events) throw new Error('sph-session is not loaded');
          active.appendEvent('plan_mode', events.planMode(enabled));
          options.listener?.({
            type: 'status',
            text: enabled
              ? 'Plan mode on — explore and design; writes are blocked until the plan is approved.'
              : 'Plan mode off.',
          });
        }
      : undefined,
    reviewPlan: options.reviewPlan,
    async escalateReadOnlyWrite(path) {
      options.listener?.({
        type: 'ask',
        id: nextEventId('ask'),
        tool: 'escalate',
        detail: `run this write at workspace sandbox: ${path}`,
      });
      return options.approver.decide({ tool: 'escalate', path });
    },
    noteMemoryTouch(absPath) {
      memory.noteTouch(absPath);
    },
    observation,
    spillRoot: options.spill?.root,
    async spawnSubagent(input) {
      // 深度预算守卫：工具保持对子代理可见，运行时统一拒绝
      // 超额派生。抛错经 runOne 的 catch 转成 isError 工具结果，模型能明确读到预算耗尽。
      const childDepth = depth + 1;
      if (childDepth > maxSubagentDepth) {
        throw new Error(`subagent depth ${childDepth} exceeds maxDepth ${maxSubagentDepth}: a subagent cannot spawn its own subagents (flat by default)`);
      }
      const child = {
        prompt: input.prompt,
        agent: input.agent,
        tools: input.tools,
        systemPrompt: input.systemPrompt,
        description: input.description,
        toolCallId: input.toolCallId,
        resumeFrom: input.resumeFrom,
        isolation: input.isolation,
      };
      if (input.background) {
        // task 回调收到自己的 record：子会话创建后回写 subagentSessionId（runChild 内完成）。
        return jobs.startTask(input.description ?? input.prompt.slice(0, 60), (signal, job) =>
          runChild({ ...child, mode: 'background', signal, jobRecord: job }));
      }
      const release = await subagentSlots.acquire();
      try {
        return await runChild({ ...child, mode: 'foreground' });
      } finally {
        release();
      }
    },
  };

  const allowed = sessionTools;

  /** 最近一条非空 assistant 正文。收束步没有新正文时用它。 */
  const latestAssistantText = (): string => {
    for (let i = mirror.length - 1; i >= 0; i--) {
      const row = mirror[i];
      if (row && row.role === 'assistant' && row.content.trim() !== '') return row.content;
    }
    return '';
  };

  // 省略不限制。父会话即使配了也不收束：用户已经看着它的输出，打断一轮改动没有收益。
  const turnLimit = depth > 0 && options.maxTurns !== undefined && options.maxTurns > 0
    ? Math.floor(options.maxTurns)
    : undefined;
  let windDownSent = false;
  for (let step = 0; turnLimit === undefined || step < turnLimit; step++) {
    if (options.signal?.aborted) throw new Error('aborted');
    assertBudget();
    if (turnLimit !== undefined && !windDownSent && step >= turnLimit - WIND_DOWN_STEPS) {
      windDownSent = true;
      appendMessage({ role: 'user', content: windDownNote(turnLimit) });
    }
    const lastStep = turnLimit !== undefined && step === turnLimit - 1;

    // 后台任务完成推送：完成唤醒父级。轮次进行中收到即注入下一步。
    // 已收尾的轮次由 TUI 在 finally 里 drain 并自动开后续轮次；delivered 标记保证不重不漏。
    for (const job of jobs.drainNotifications()) {
      if (!notify) throw new Error('sph-schedule is not loaded');
      appendMessage({ role: 'user', content: notify(job) });
    }

    // 父级/模型发来的消息（send_subagent_message）在下一步顶部入列——投递到
    // 下一个安全点，不打断当前 LLM 调用。
    for (const text of options.inbox?.drain() ?? []) {
      appendMessage({ role: 'user', content: `[message from parent session — steering input, not a new task assignment]\n${text}` });
    }

    // 触碰到的嵌套指令在进入下一次 LLM 请求前入列。措辞与逃逸同 system 里的项目指令一致，
    // 否则模型会按两套规则对待同一类内容。
    for (const touch of memory.drain()) {
      appendMessage({ role: 'user', content: touchInstructionBlock(touch.relPath, touch.text) });
    }

    // 投影 + 压缩落盘集中一处：超限重试要再走一遍同样的流程。
    const buildProjection = async (force: boolean): Promise<ChatMessage[]> => {
      const auxUsage = options.onAuxUsage;
      flushWireAttachments(wire);
      const projection = await projectContext({
        messages: mirror,
        compaction,
        base: wire.messages,
        contextWindow: options.contextWindow,
        // 摘要可以走便宜的小模型：它只读不写，且输出格式固定，是最典型的降本点。
        client: options.compactClient ?? options.client,
        signal: options.signal,
        lastUsage,
        lastUsageAnchor: usageAnchor,
        force,
        system: systemPrompt,
        // stub 边界冻结：首次由投影回报，之后不再随轮次前移——前移一格就是一次
        // 历史中段改写，缓存从切点起全部作废。摘要落地时重置（摘要即新边界）。
        stubFromSession,
        tools: registry.schemas(allowed),
        // 压缩摘要的花费也是真花钱，一样计入预算（未配 onAuxUsage 时也要计）。
        onUsage: (usage: TokenUsage) => {
          chargeTokens(usage.promptTokens, usage.completionTokens);
          auxUsage?.(usage, 'compaction');
        },
        onCompacting: () => {
          options.listener?.({ type: 'status', text: 'Folding context…' });
        },
      });
      // 前缀分段观测：tools / system 本该是会话常量，消息序列本该只追加。
      // 压缩是计划中的换会话，不记成 prefix_change——那会和「前缀被意外改写」混在一起。
      const snapshot: PrefixSnapshot = {
        toolsHash: hashText(JSON.stringify(registry.schemas(allowed))),
        systemHash: hashText(systemPrompt),
        messageHashes: projection.messages.map((message) => hashMessage(message)),
      };
      const next = projection.compaction;
      const fork = next !== undefined && next.covered !== (compaction?.covered ?? 0);
      if (fork && next) {
        const fromSessionId = active.id;
        const opened = openCompactedSession({
          factory: sessions,
          from: active,
          workspaceRoot: options.workspaceRoot,
          makeCurrent: depth === 0,
          summary: next.summary,
          covered: next.covered,
          messages: mirror,
          depth,
          tokensUsed: sessionTokens,
        });
        active = opened.session;
        mirror = opened.mirror;
        wire = wireFromMessages(mirror);
        compaction = undefined;
        // 新会话的下标和旧冻结边界对不上。摘要本身就是新的系列起点。
        stubFromSession = undefined;
        lastUsage = undefined;
        usageAnchor = mirror.length;
        // 尾部里还没落盘的行已经写进新会话。再走 persistTurnStart 会写第二遍。
        turnPersisted = true;
        pendingRows.clear();
        ctx.sessionId = active.id;
        cacheTracker.expectColdStart('compaction');
        prefixPrev = snapshot;
        options.listener?.({
          type: 'session_fork',
          sessionId: active.id,
          fromSessionId,
          covered: next.covered,
        });
        options.listener?.({ type: 'status', text: `context compacted (${next.covered} messages summarized)` });
      } else {
        if (projection.stubbedFromSession !== undefined && stubFromSession === undefined) {
          stubFromSession = projection.stubbedFromSession;
        }
        const prefixChanges = observePrefix(prefixPrev, snapshot);
        prefixPrev = snapshot;
        if (prefixChanges.length > 0) {
          active.appendEvent('prefix_change', { changes: prefixChanges });
        }
      }
      return projection.messages;
    };

    let projected = await buildProjection(false);

    const streamed = { text: false, thinking: false };
    // 思考段必须在 complete 之前开组：正文会断开当前分组，后补 start 会把「思考结束」插到前言后面。
    // 状态行是否显示 Thinking… 由 TUI 看有没有 thinking_delta，这里只保证 start/end 成对。
    const thinkingId = nextEventId('thinking');
    options.listener?.({ type: 'thinking_start', id: thinkingId });
    let reply: Awaited<ReturnType<RunTurnOptions['client']['complete']>>;
    let anchorAt = mirror.length;
    // provider 判定超窗时压缩后重试一次。上限 1 次：再失败说明单轮内容本身就超窗，
    // 重试只会再烧一次调用。已经给用户看过正文**或思考链**时绝不重试，否则会看到重复内容。
    let overflowRetried = false;
    // transport 重试的累计墙钟。不落盘的话，长思考被网关反复掐断时 JSONL 里只是一段几十分钟的时间空洞。
    const transportRetryStartedAt = Date.now();
    for (;;) {
      anchorAt = mirror.length;
      try {
        reply = await options.client.complete(
          projected,
          // 最后一步不给工具：模型只能写正文。再给一次工具调用，结果会在提交前被丢掉。
          lastStep ? [] : registry.schemas(allowed),
          options.signal,
          (delta) => {
            if (delta.thinking) {
              persistTurnStart();
              streamed.thinking = true;
              options.listener?.({ type: 'thinking_delta', id: thinkingId, text: delta.thinking });
            }
            if (delta.text) {
              persistTurnStart();
              streamed.text = true;
              options.listener?.({ type: 'text', text: delta.text });
            }
          },
          (info) => {
            const text = `Retrying LLM stream (attempt ${info.attempt}): ${info.message}`;
            if (info.kind === 'compat') {
              active.appendEvent('compat_retry', {
                attempt: info.attempt,
                message: info.message,
                text,
              });
            }
            if (info.kind === 'transport') {
              streamed.text = false;
              streamed.thinking = false;
              options.listener?.({ type: 'stream_retry' });
              // 与 compat_retry 同等地位落盘：断流次数、错误原文、距本跳开始的耗时
              // （maxRetries 缺省时省略 max 字段，旧记录保持形状稳定）。
              active.appendEvent('stream_retry', {
                attempt: info.attempt,
                ...(info.maxRetries === undefined ? {} : { max: info.maxRetries }),
                message: info.message,
                text,
                elapsedMs: Date.now() - transportRetryStartedAt,
              });
            }
            // 传输抖动与参数降级都进工作状态行（TUI 按同一条文案累计次数，不进转录）。
            options.listener?.({ type: 'status', level: 'warn', text });
          },
        );
        break;
      } catch (error) {
        const canRetry = isContextOverflow(error)
          && !overflowRetried
          && !streamed.text
          && !streamed.thinking
          && !options.signal?.aborted;
        if (!canRetry) {
          // 思考中途失败：补发 end 信号，防止消费端卡在 running 态。
          options.listener?.({ type: 'thinking_end', id: thinkingId, content: '' });
          throw error;
        }
        overflowRetried = true;
        options.listener?.({ type: 'status', text: '上下文超窗：已强制压缩，正在重试该请求...' });
        projected = await buildProjection(true);
      }
    }
    persistTurnStart();
    options.listener?.({ type: 'thinking_end', id: thinkingId, content: reply.thinking ?? '' });
    if (reply.text && !streamed.text) options.listener?.({ type: 'text', text: reply.text });
    if (reply.usage) {
      lastUsage = reply.usage;
      usageAnchor = anchorAt;
      chargeTokens(reply.usage.promptTokens, reply.usage.completionTokens);
      active.appendEvent('usage', { ...reply.usage });
      options.listener?.({
        type: 'usage',
        promptTokens: reply.usage.promptTokens,
        completionTokens: reply.usage.completionTokens,
        ...(reply.usage.cachedTokens === undefined ? {} : { cachedTokens: reply.usage.cachedTokens }),
        ...(reply.usage.costUsd === undefined ? {} : { costUsd: reply.usage.costUsd }),
      });
      // 提示缓存未命中：不打扰界面（一次性的 best-effort 缓存抖动不值得打断阅读），
      // 落成会话事件留痕——反复出现时在会话文件里看得到规律，sph export 也能带出来。
      const miss = cacheTracker.observe({
        promptTokens: reply.usage.promptTokens,
        ...(reply.usage.cachedTokens === undefined ? {} : { cachedTokens: reply.usage.cachedTokens }),
        at: Date.now(),
        ...(options.model === undefined ? {} : { modelKey: options.model }),
      });
      if (miss) {
        active.appendEvent('cache_miss', {
          missedTokens: miss.missedTokens,
          modelChanged: miss.modelChanged,
          likelyExpired: miss.likelyExpired,
          expected: miss.expected,
          ...(miss.reason === undefined ? {} : { reason: miss.reason }),
          ...(miss.idleMs === undefined ? {} : { idleMs: miss.idleMs }),
          text: describeCacheMiss(miss),
        });
      }
    }

    if (reply.finishReason === 'length') {
      // 不当成异常抛出：半截正文已经上屏。不提示的话 TUI 只是静默空闲，像模型自己停了。
      options.listener?.({
        type: 'status',
        level: 'warn',
        text: 'Output truncated (hit max_tokens). Raise max_tokens, or send another message to continue.',
      });
    }

    const reasoning = reply.reasoning?.length ? { reasoning: reply.reasoning } : {};
    // Anthropic thinking 回放载荷：思考明文 + 签名随 assistant 行落盘，下一轮
    // toAnthropicRequest 才能以 thinking 块开头（官方 API 对含 tool_use 的消息强制）。
    const thinkingReplay = (reply.thinking || reply.thinkingSignature)
      ? {
          ...(reply.thinking ? { thinking: reply.thinking } : {}),
          ...(reply.thinkingSignature ? { thinkingSignature: reply.thinkingSignature } : {}),
        }
      : {};
    // 最后一步的工具表是空的。模型仍返回工具调用时，那些调用没有结果可配，
    // 丢掉它们，把已有正文当收束。先落盘再找：否则这条正文还不在 mirror 里。
    if (lastStep && reply.toolCalls?.length && (reply.text ?? '').trim()) {
      appendMessage({ role: 'assistant', content: reply.text ?? '', ...reasoning, ...thinkingReplay });
    }
    if (lastStep && reply.toolCalls?.length) {
      const content = latestAssistantText();
      if (!content) throw new Error(`tool loop exceeded ${turnLimit} steps`);
      options.listener?.({
        type: 'status',
        level: 'warn',
        text: `Step limit reached (${turnLimit}). Report is what was already established.`,
      });
      active.appendEvent('turn_end', { depth, finishReason: 'step_limit' });
      await runTurnEnd('step_limit');
      options.listener?.({ type: 'done' });
      return;
    }

    if (!reply.toolCalls?.length) {
      // 只有明确的 stop/length/content-filter 且没有工具才退出。
      //
      // 线协议写 `tool_calls`，内部测试写 `tool-calls`，Anthropic 写 `tool_use`——漏掉任何
      // 一种都会把「该调工具」当成收工，表现为突然停止。
      const finish = reply.finishReason;
      const toolFinish = finish === 'tool_calls' || finish === 'tool-calls' || finish === 'tool_use';
      const stopped = finish !== undefined && !toolFinish && finish !== 'unknown';
      if (!stopped) {
        // 没有明确 finish 且没有工具，不当成成功空消息。有半截才落盘再续。
        if (reply.text || reply.thinking || reply.reasoning?.length) {
          appendMessage({ role: 'assistant', content: reply.text ?? '', ...reasoning, ...thinkingReplay });
        }
        options.listener?.({
          type: 'status',
          level: 'warn',
          text: `Stream ended without a finish reason (${finish ?? 'none'}) — continuing the turn.`,
        });
        continue;
      }
      appendMessage({ role: 'assistant', content: reply.text ?? '', ...reasoning, ...thinkingReplay });
      if (lastStep) {
        options.listener?.({
          type: 'status',
          level: 'warn',
          text: `Step limit reached (${turnLimit}). Report is what was already established.`,
        });
      }
      active.appendEvent('turn_end', { depth, finishReason: lastStep ? 'step_limit' : finish });
      await runTurnEnd(lastStep ? 'step_limit' : finish);
      options.listener?.({ type: 'done' });
      return;
    }

    const parseErrors = new Map<string, string>();
    const parsedCalls = reply.toolCalls.map((call) => {
      try {
        return { id: call.id, name: call.name, arguments: parseArgs(call.arguments) };
      } catch (error) {
        parseErrors.set(call.id, errorMessage(error));
        return { id: call.id, name: call.name, arguments: {} };
      }
    });
    appendMessage({
      role: 'assistant',
      content: reply.text ?? '',
      toolCalls: parsedCalls,
      ...reasoning,
      ...thinkingReplay,
    });

    const planSeam = services.get<PlanModeSeam>(PLAN_MODE_SERVICE);
    await runToolBatch({
      calls: parsedCalls,
      isParallel: (name) => registry.isConcurrencySafe(name),
      signal: options.signal,
      onStart(call) {
        active.appendEvent('tool_intent', { id: call.id, name: call.name, args: call.arguments });
        options.listener?.({ type: 'tool_start', name: call.name, id: call.id, args: call.arguments });
      },
      async execute(call) {
        const parseError = parseErrors.get(call.id);
        if (parseError) return { ok: false, content: `invalid tool arguments: ${parseError}` };
        const tool = registry.find(call.name);
        const denied = toolDenied(registry, call.name, call.arguments, {
          allowed,
          depth,
          planMode: options.planMode?.active,
          plan: planSeam,
        });
        let result: ToolResult;
        if (denied || !tool) result = { ok: false, content: denied ?? `unknown tool: ${call.name}` };
        else {
          let blocked: string | undefined;
          for (const hook of hooks) {
            if (!hook.beforeTool) continue;
            try {
              blocked = await hook.beforeTool({ name: call.name, args: call.arguments });
            } catch (error) {
              blocked = errorMessage(error);
            }
            if (blocked) break;
          }
          result = blocked
            ? { ok: false, content: blocked }
            : await tool.execute(call.arguments, ctx, call.id);
          if (!blocked) {
            for (const hook of hooks) {
              if (!hook.afterTool) continue;
              try {
                const verdict = await hook.afterTool(
                  { name: call.name, args: call.arguments },
                  { ok: result.ok, content: result.content },
                );
                if (verdict?.deny) result = { ok: false, content: verdict.deny };
              } catch (error) {
                result = { ok: false, content: errorMessage(error) };
              }
            }
          }
        }
        // 超长结果落盘：上下文里只留头尾预览 + 绝对路径。写盘失败时 persist 返回 undefined，
        // 此时保留原文——spill 是优化，不能变成结果丢失的原因。
        if (options.spill && result.ok && !result.images?.length && !result.documents?.length) {
          const spilled = options.spill.persist(call.name, result.content);
          if (spilled !== undefined) result = { ...result, content: spilled };
        }
        return result;
      },
      onCommit(call, result) {
        appendMessage({
          role: 'tool',
          content: result.content,
          toolCallId: call.id,
          toolName: call.name,
          images: result.images,
          documents: result.documents,
        });
        // 失败历史落盘：成功对恢复没有价值，失败能让恢复后的模型知道上次卡在哪。
        if (!result.ok) {
          if (!events) throw new Error('sph-session is not loaded');
          active.appendEvent('tool_result', events.toolFailure(call.name, result.content));
        }
        options.listener?.({ type: 'tool_end', name: call.name, id: call.id, ok: result.ok, content: result.content });
      },
    });

    const nextTodos = JSON.stringify(todos.list());
    if (nextTodos !== todoSnapshot) {
      todoSnapshot = nextTodos;
      active.appendEvent('todo', todoEventData(todos.list()) as unknown as Record<string, unknown>);
    }
  }
  // 配了上限的子会话：最后一步仍在调工具，且没有新正文。上一条非空正文也算收束。
  // 父会话走不到这里——它的循环没有上限。
  const leftover = latestAssistantText();
  if (leftover && turnLimit !== undefined) {
    options.listener?.({
      type: 'status',
      level: 'warn',
      text: `Step limit reached (${turnLimit}). Report is what was already established.`,
    });
    active.appendEvent('turn_end', { depth, finishReason: 'step_limit' });
    await runTurnEnd('step_limit');
    options.listener?.({ type: 'done' });
    return;
  }
  throw new Error(`tool loop exceeded ${turnLimit} steps`);
}
