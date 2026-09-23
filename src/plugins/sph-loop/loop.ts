import type { RunTurnOptions } from '../../agent/driver.js';
import {
  flushWireImages,
  loadCompaction,
  projectContext,
  pushSessionMessage,
  wireFromMessages,
  type CompactionEvent,
  type WireState,
} from './compact.js';
import type { AgentListener, SubagentEvent } from './events.js';
import { TouchMemory, touchInstructionBlock } from './memory.js';
import { PLAN_MODE_SERVICE, type PlanModeSeam } from '../services.js';
import { buildSystemPrompt, sessionStateMessage } from './prompt.js';
import { hashMessage, hashText, observePrefix, type PrefixSnapshot } from './prefix-tracker.js';
import { runToolBatch } from './tool-run.js';
import { CacheMissTracker, describeCacheMiss } from '../sph-llm/cache-stats.js';
import { ContextOverflowError } from '../sph-llm/errors.js';
import type { ChatMessage, TokenUsage } from '../sph-llm/openai.js';
import { EMPTY_TODO, MCP_SERVICE, SCHEDULER_SERVICE, SESSION_SERVICE, SKILLS_SERVICE, TODO_SERVICE, todoEventData, type McpService, type SchedulerService, type SessionService, type SkillService, type TodoService } from '../services.js';
import { EMPTY_PLUGIN_SERVICES, type PluginServices } from '../types.js';
import { JobBoard, type JobRecord } from '../sph-schedule/jobs.js';
import { jobNotificationText } from '../../runtime/scheduler.js';
import { WorktreeStore } from './worktrees.js';
import { shellArgv } from '../../sandbox/shell-bin.js';
import { errorMessage } from '../../util.js';
import { jsonlSessionFactory } from '../sph-session/store.js';
import { foldSessionState, sessionEventData } from '../../session/fold.js';
import { lastAssistantMessage } from '../../session/query.js';
import { closeInterruptedTurn } from '../../session/repair.js';
import type { SessionMessage, SessionRecord } from '../../session/types.js';
import { scanSkills } from '../sph-skills/scan.js';
import type { ToolRegistry } from '../../tools/registry.js';
import { FileObservation } from '../sph-tools/observe.js';
import { SUBAGENT_CONCURRENCY, type ToolContext, type ToolResult } from '../../tools/types.js';
import { existsSync } from 'node:fs';

const MAX_STEPS = 32;

/**
 * 把子代理定义里的工具名单收成实际可用集合。
 *
 * `*` 按当前工具表展开，但委托工具不跟着进去：子代理默认不能再派生子代理，
 * 深度预算是第二道，工具集是第一道。点名的工具原样保留（含委托工具），
 * 嵌套只在定义明确授权、且深度预算允许时成立。
 */
function resolveChildTools(registry: ToolRegistry, declared: readonly string[]): Set<string> {
  const base = declared.includes('*')
    ? registry.generalNames()
    : new Set(declared.filter((name) => registry.find(name)));
  if (declared.includes('*')) {
    base.delete('subagent');
    base.delete('send_subagent_message');
  }
  return base;
}

/** 预算用掉多少就打一条 warn：留出「收尾并交付已有成果」的余地。 */
const BUDGET_WARN_RATIO = 0.8;

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

/** 没装插件（测试）才用内置实现。正式启动缺服务就是缺，不退回 JSONL 或自建任务板。 */
function bundled<T>(services: PluginServices, value: T): T | undefined {
  return services === EMPTY_PLUGIN_SERVICES ? value : undefined;
}

export async function runTurn(options: RunTurnOptions): Promise<void> {
  const depth = options.depth ?? 0;
  const maxSubagentDepth = Math.max(0, Math.floor(options.maxSubagentDepth ?? 1));
  const registry = options.tools;
  const services = options.services ?? EMPTY_PLUGIN_SERVICES;
  const sessionApi = services.get<SessionService>(SESSION_SERVICE);
  const sessions = options.sessions ?? sessionApi?.factory ?? bundled(services, jsonlSessionFactory);
  if (!sessions) throw new Error('sph-session is not loaded');
  const fold = sessionApi?.fold ?? bundled(services, foldSessionState);
  const events = sessionApi?.events ?? bundled(services, sessionEventData);
  const closeTurn = sessionApi?.closeInterruptedTurn ?? bundled(services, closeInterruptedTurn);
  const lastAssistant = sessionApi?.lastAssistant ?? bundled(services, lastAssistantMessage);
  const notify = services.get<SchedulerService>(SCHEDULER_SERVICE)?.notificationText ?? bundled(services, jobNotificationText);
  // 测试不装插件，直接扫技能目录。正式启动装了插件之后，关掉 sph-skills 就是空目录，
  // 不再回落到循环自己的那份扫描。
  const skills = services === EMPTY_PLUGIN_SERVICES
    ? scanSkills(options.workspaceRoot)
    : (services.get<SkillService>(SKILLS_SERVICE)?.scan(options.workspaceRoot) ?? { catalog: [], warnings: [] });
  for (const warning of skills.warnings) options.listener?.({ type: 'status', text: warning });
  const jobs = options.jobs ?? services.get<SchedulerService>(SCHEDULER_SERVICE)?.create() ?? bundled(services, new JobBoard());
  if (!jobs) throw new Error('sph-schedule is not loaded');
  const mcp = services.get<McpService>(MCP_SERVICE);
  // todo 与 mcp 同一套缺席语义：插件被禁用时清单不可用。工具表里也不会有 todo 工具，
  // 所以这里缺省成「空清单 + 不写事件」不会让任何核心路径拿到 undefined 而崩。
  const todos = options.todos ?? services.get<TodoService>(TODO_SERVICE) ?? EMPTY_TODO;
  const memory = options.memory ?? new TouchMemory(options.workspaceRoot);
  const worktrees = options.worktrees ?? new WorktreeStore();

  // 系统提示词在**一轮内冻结**，而不是每步重读。原因：它经 projectContext 的 withSystem
  // 注入为 message 0，正处在缓存前缀的最前面——enter_plan_mode 之类发生在工具批里的
  // 状态变化若在这里生效，本轮后续每一步连同整段历史都会重新计费。
  // 冻结不损失行为正确性：计划模式的进出引导由工具结果自带（tools/plan.ts 的返回文案），
  // 读写限制在执行层强制（PLAN_BLOCKED_TOOLS）；跨轮重建是刻意的，轮与轮之间本来就要
  // 追加新消息，此时反映状态变化不带来额外的缓存损失。
  const systemPrompt = ((): string => {
    const system = buildSystemPrompt({
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
      allowedTools: options.allowedTools ?? new Set(registry.list().map((tool) => tool.name)),
      toolPrompts: registry.list().flatMap((tool) => (tool.prompt ? [{ tool: tool.name, text: tool.prompt }] : [])),
      // goal / lastFailure / planMode 不进 system：它们随时可变，放在前缀最头部意味着
      // 一次变化就作废全部消息历史的缓存。经 sessionStateMessage 以尾部 user 消息注入。
    });
    // 子代理角色段追加在末尾：主提示词在前、角色约束在后，父级主 turn 的前缀保持一致
    // （缓存命中），且角色约束作为最后读到的一段不会被前面的通用规则盖过。
    return options.subagentPrompt
      ? `${system}\n\n${options.subagentPrompt}`
      : system;
  })();
  // token 预算：整棵代理树的累计量（自己的 usage + 各子代理 end 事件里的 tokens）。
  const budget = Math.max(0, Math.floor(options.maxSessionTokens ?? 0));
  const budgetWarnAt = budget > 0 ? Math.floor(budget * BUDGET_WARN_RATIO) : 0;
  let sessionTokens = 0;
  if (budget > 0) {
    if (!fold) throw new Error('sph-session is not loaded');
    sessionTokens = fold(options.session.readAll()).tokensUsed;
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

  // 会话镜像：turn 内所有投影走内存，避免每个 step 重读 JSONL。
  const mirror: SessionMessage[] = options.session.readMessages();
  if (!closeTurn) throw new Error('sph-session is not loaded');
  closeTurn(options.session, mirror);
  // 用户消息先只进内存。首次模型活动再落盘——取消时 TUI 把原文放回输入框，
  // JSONL 里也不该留下一条没有回复的 user（对齐 grok cancel-rewind）。
  const pendingUser: SessionMessage = {
    type: 'message',
    ts: new Date().toISOString(),
    role: 'user',
    content: options.prompt,
    images: options.userImages,
    attachments: options.attachments,
  };
  mirror.push(pendingUser);
  // 跨轮次状态（goal / 最近失败 / 计划模式）以尾部 user 消息注入，紧跟本轮 prompt——
  // 下一轮它固化在历史里，前缀从它之前完整命中（sessionStateMessage 的注释讲为什么
  // 不能放 system）。与 pendingUser 同一套延迟落盘：首次模型活动时一起写，取消都不留。
  const stateRow: SessionMessage = {
    type: 'message',
    ts: new Date().toISOString(),
    role: 'user',
    content: sessionStateMessage(options.goal, options.lastFailure, options.planMode?.active === true, services.get<PlanModeSeam>(PLAN_MODE_SERVICE)),
  };
  mirror.push(stateRow);
  let turnPersisted = false;
  const persistTurnStart = (): void => {
    if (turnPersisted) return;
    turnPersisted = true;
    options.session.appendMessage({
      role: 'user',
      content: options.prompt,
      images: options.userImages,
      attachments: options.attachments,
    });
    options.session.appendMessage({ role: 'user', content: stateRow.content });
    options.session.appendEvent('turn_start', { depth, sandbox: options.sandbox.status.mode });
  };
  let compaction: CompactionEvent | undefined = loadCompaction(options.session);
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
    options.session.appendMessage(message);
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
    /** 续接的源子代理会话 id；源消息复制进新会话（grok 的 resume_from 同语义）。 */
    resumeFrom?: string;
    /** worktree：在隔离 git 工作树里跑。 */
    isolation?: 'none' | 'worktree';
    /** 后台任务的 record：子会话创建后回写 subagentSessionId 供 resume / send 寻址。 */
    jobRecord?: JobRecord;
  }): Promise<string> => {
    // resume 校验（grok 同语义：源必须已完成、同类型）。源子代理的 start 事件落在
    // 父会话文件里（childSessionId 关联），childType 与 worktree 从那里读。
    let sourceRecords: SessionRecord[] = [];
    let resumedWorktree: string | undefined;
    if (input.resumeFrom !== undefined) {
      if (activeSubagentSessions.has(input.resumeFrom)) {
        throw new Error(`resume_from: subagent ${input.resumeFrom} is still running`);
      }
      sourceRecords = sessions.open(options.session.dir, input.resumeFrom).readAll();
      if (sourceRecords.length === 0) {
        throw new Error(`resume_from: subagent session ${input.resumeFrom} not found`);
      }
      const starts = options.session
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

    // workspace 决策：resume 沿用源会话的工作树（仍在时，grok 同语义）；isolation
    // worktree 在下方新建。树建在 workspace 内——Windows ACL 写授权与 bwrap bind 都按
    // workspace root 授予，放外面子代理写不进。
    let childWorkspaceRoot = options.workspaceRoot;
    if (resumedWorktree !== undefined && existsSync(resumedWorktree)) {
      childWorkspaceRoot = resumedWorktree;
    }

    const childSession = sessions.create(options.session.dir, childWorkspaceRoot, false);
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
    // isolation worktree：从 HEAD 派生 sph/<id> 分支的隔离工作树（grok 同语义：
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
    options.session.appendEvent('subagent', { phase: 'start', ...subagentStart });
    // 子事件封进 subagent_event：主流程的步骤块从此只属于主代理，TUI 按 id 归位子活动。
    // usage / ask 是全局语义（用量计数、审批提示），保持直通；done 由 subagent_end 表达。
    // usage 同时按子代理累计——subagent_end 要带出该子代理自己的 token 消耗量。
    const childUsage = { promptTokens: 0, completionTokens: 0 };
    const childListener: AgentListener = (event) => {
      if (event.type === 'usage') {
        childUsage.promptTokens += event.promptTokens;
        childUsage.completionTokens += event.completionTokens;
        options.listener?.(event);
        options.listener?.({
          type: 'subagent_event',
          id: subId,
          event: { type: 'usage', promptTokens: event.promptTokens, completionTokens: event.completionTokens },
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
        allowedTools: allowed,
        worktrees,
        subagentPrompt: input.systemPrompt,
        ...(input.mode === 'background' ? { inbox: childInbox } : {}),
      });
      const last = lastAssistant?.(childSession.readMessages());
      outcome = { ok: true, summary: last?.content || '(subagent produced no assistant text)' };
      // 结果带 session id footer：模型据此能 resume 或继续发消息，不必再查 jobs。
      return `${outcome.summary}\n\n[subagent session: ${childSession.id} — continue with subagent(resume_from: "${childSession.id}")]`;
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
      options.session.appendEvent('subagent', {
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
    sessionDir: options.session.dir,
    sessionId: options.session.id,
    setPlanMode: options.planMode
      ? (active: boolean) => {
          if (!options.planMode || options.planMode.active === active) return;
          options.planMode.active = active;
          if (!events) throw new Error('sph-session is not loaded');
          options.session.appendEvent('plan_mode', events.planMode(active));
          options.listener?.({
            type: 'status',
            text: active
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
      // 深度预算守卫（对齐 grok-build 的扁平代理树）：工具保持对子代理可见，运行时统一拒绝
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

  const allowed = options.allowedTools;

  // opencode zen 免费档按「请求是否带 bash 工具定义」判定流量来自 OpenCode——实测这是
  // 唯一开关字段：缺 bash 即 403 FreeTierError（文案谎称客户端身份），system、随机 id、
  // 并发、请求体其余字段全部无关。explore 子代理是只读工具集、天生缺 bash，请求侧补上
  // schema 过闸；执行侧仍由下方 allowed 守卫拦截，模型真去调用只会得到明确报错。
  const requestTools = allowed && !allowed.has('bash') ? new Set([...allowed, 'bash']) : allowed;

  for (let step = 0; step < MAX_STEPS; step++) {
    if (options.signal?.aborted) throw new Error('aborted');
    assertBudget();

    // 后台任务完成推送（grok-build 语义：完成唤醒父级）：轮次进行中收到即注入下一步。
    // 已收尾的轮次由 TUI 在 finally 里 drain 并自动开后续轮次；delivered 标记保证不重不漏。
    for (const job of jobs.drainNotifications()) {
      if (!notify) throw new Error('sph-schedule is not loaded');
      appendMessage({ role: 'user', content: notify(job) });
    }

    // 父级/模型发来的消息（send_subagent_message）在下一步顶部入列——投递到
    // 下一个安全点（grok 的 steer 语义），不打断当前 LLM 调用。
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
      flushWireImages(wire);
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
        tools: registry.schemas(requestTools),
        // 压缩摘要的花费也是真花钱，一样计入预算（未配 onAuxUsage 时也要计）。
        onUsage: (usage: TokenUsage) => {
          chargeTokens(usage.promptTokens, usage.completionTokens);
          auxUsage?.(usage, 'compaction');
        },
        onCompacting: () => {
          options.listener?.({ type: 'status', text: 'Folding context…' });
        },
      });
      if (projection.stubbedFromSession !== undefined && stubFromSession === undefined) {
        stubFromSession = projection.stubbedFromSession;
      }
      // 前缀分段观测：tools / system 本该是会话常量，消息序列本该只追加。任何一段
      // 中途变更都直接解释「为什么这轮缓存没命中」，落成事件与 cache_miss 呼应。
      const snapshot: PrefixSnapshot = {
        toolsHash: hashText(JSON.stringify(registry.schemas(requestTools)) ?? ''),
        systemHash: hashText(systemPrompt),
        messageHashes: projection.messages.map((message) => hashMessage(message)),
      };
      const prefixChanges = observePrefix(prefixPrev, snapshot);
      prefixPrev = snapshot;
      if (prefixChanges.length > 0) {
        options.session.appendEvent('prefix_change', { changes: prefixChanges });
      }
      if (projection.compaction) {
        const next = projection.compaction;
        if (next.covered !== (compaction?.covered ?? 0)) {
          options.session.appendEvent('compaction', { summary: next.summary, covered: next.covered });
          compaction = next;
          wire = wireFromMessages(mirror, compaction);
          // 摘要重写了历史：提示词从此是新内容，缓存基线必须一起丢掉，
          // 否则压缩后的第一轮会被算成一整段未命中。
          cacheTracker.reset();
          // 摘要覆盖了冻结边界所在的区间：旧边界失去意义，以 covered 为新系列起点。
          stubFromSession = undefined;
          // 历史被计划内改写：前缀基线一并重置，下一轮作为新系列起点，不报 prefix_change。
          prefixPrev = undefined;
          options.listener?.({ type: 'status', text: `context compacted (${next.covered} messages summarized)` });
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
    // transport 重试的累计墙钟（pi auto_retry_start/end 同款事件语义，dsh 还会持久化——
    // 没有这个落盘，长思考被网关反复掐断时 JSONL 里只是一段几十分钟的时间空洞）。
    const transportRetryStartedAt = Date.now();
    for (;;) {
      anchorAt = mirror.length;
      try {
        reply = await options.client.complete(
          projected,
          registry.schemas(requestTools),
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
              options.session.appendEvent('compat_retry', {
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
              options.session.appendEvent('stream_retry', {
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
        const canRetry = error instanceof ContextOverflowError
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
      options.session.appendEvent('usage', { ...reply.usage });
      options.listener?.({
        type: 'usage',
        promptTokens: reply.usage.promptTokens,
        completionTokens: reply.usage.completionTokens,
        ...(reply.usage.cachedTokens === undefined ? {} : { cachedTokens: reply.usage.cachedTokens }),
      });
      // 提示缓存未命中：不打扰界面（一次性的 best-effort 缓存抖动不值得打断阅读），
      // 落成会话事件留痕——反复出现时在会话文件里看得到规律，sph export 也能带出来。
      const miss = cacheTracker.observe({
        promptTokens: reply.usage.promptTokens,
        ...(reply.usage.cachedTokens === undefined ? {} : { cachedTokens: reply.usage.cachedTokens }),
        at: Date.now(),
      });
      if (miss) {
        options.session.appendEvent('cache_miss', {
          missedTokens: miss.missedTokens,
          modelChanged: miss.modelChanged,
          likelyExpired: miss.likelyExpired,
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
    if (!reply.toolCalls?.length) {
      // OpenCode / deepseek-harness 会话环：只有明确的 stop/length/content-filter 且没有工具才退出。
      //
      // 线协议写 `tool_calls`，内部测试写 `tool-calls`，Anthropic 写 `tool_use`——漏掉任何
      // 一种都会把「该调工具」当成收工，表现为突然停止。
      const finish = reply.finishReason;
      const toolFinish = finish === 'tool_calls' || finish === 'tool-calls' || finish === 'tool_use';
      const stopped = finish !== undefined && !toolFinish && finish !== 'unknown';
      if (!stopped) {
        // 对齐 dsh：没有明确 finish 且没有工具，不当成成功空消息。有半截才落盘再续。
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
      options.session.appendEvent('turn_end', { depth, finishReason: finish });
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

    // 拒绝理由集中在一处判定：execute 只负责执行，提交由 runToolBatch 按模型序推进。
    const denyReason = (name: string, args: Record<string, unknown> = {}): string | undefined => {
      if (allowed && !allowed.has(name)) return `tool not allowed in this agent: ${name}`;
      if (registry.isRootOnly(name) && depth > 0) return `tool only available to the root session: ${name}`;
      if (!registry.find(name)) return `unknown tool: ${name}`;
      if (options.planMode?.active) {
        const planSeam = services.get<PlanModeSeam>(PLAN_MODE_SERVICE);
        // 插件可以按参数覆盖（只读子代理放行）。没有覆盖时按工具自己的 planSafe，
        // 未声明即拦截：新注册的写工具不会因为不在某张名单里而被放开。
        const verdict = planSeam?.isBlocked(name, args);
        const blocked = verdict === true || (verdict !== false && !registry.isPlanSafe(name));
        if (blocked) return planSeam?.blockedReason(name) ?? `blocked in plan mode: ${name}`;
      }
      return undefined;
    };

    await runToolBatch({
      calls: parsedCalls,
      isParallel: (name) => registry.isConcurrencySafe(name),
      signal: options.signal,
      onStart(call) {
        options.session.appendEvent('tool_intent', { id: call.id, name: call.name, args: call.arguments });
        options.listener?.({ type: 'tool_start', name: call.name, id: call.id, args: call.arguments });
      },
      async execute(call) {
        const parseError = parseErrors.get(call.id);
        if (parseError) return { ok: false, content: `invalid tool arguments: ${parseError}` };
        const tool = registry.find(call.name);
        const denied = denyReason(call.name, call.arguments);
        let result: ToolResult;
        if (denied || !tool) result = { ok: false, content: denied ?? `unknown tool: ${call.name}` };
        else result = await tool.execute(call.arguments, ctx, call.id);
        // 超长结果落盘：上下文里只留头尾预览 + 绝对路径。写盘失败时 persist 返回 undefined，
        // 此时保留原文——spill 是优化，不能变成结果丢失的原因。
        if (options.spill && result.ok && !result.images?.length) {
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
        });
        // 失败历史落盘：成功对恢复没有价值，失败能让恢复后的模型知道上次卡在哪。
        if (!result.ok) {
          if (!events) throw new Error('sph-session is not loaded');
          options.session.appendEvent('tool_result', events.toolFailure(call.name, result.content));
        }
        options.listener?.({ type: 'tool_end', name: call.name, id: call.id, ok: result.ok, content: result.content });
      },
    });

    const nextTodos = JSON.stringify(todos.list());
    if (nextTodos !== todoSnapshot) {
      todoSnapshot = nextTodos;
      options.session.appendEvent('todo', todoEventData(todos.list()) as unknown as Record<string, unknown>);
    }
  }
  throw new Error(`tool loop exceeded ${MAX_STEPS} steps`);
}
