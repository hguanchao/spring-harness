import type { Approver } from '../approval/policy.js';
import { loadCompaction, projectContext, type CompactionEvent } from './compact.js';
import type { AgentListener } from './events.js';
import { TouchMemory } from './memory.js';
import { buildSystemPrompt } from './prompt.js';
import { ContextOverflowError } from '../llm/errors.js';
import type { ChatMessage, LlmClient, TokenUsage } from '../llm/openai.js';
import { McpHub } from '../mcp/hub.js';
import { JobBoard } from '../runtime/jobs.js';
import { PersistentShell } from '../runtime/persistent-shell.js';
import type { SpillStore } from '../runtime/spill.js';
import { TodoList } from '../runtime/todos.js';
import type { SandboxHandle } from '../sandbox/open.js';
import { resolveShellBinary } from '../sandbox/shell-bin.js';
import { createSession, type JsonlSession } from '../session/store.js';
import { sessionEventData, type SessionFailure } from '../session/fold.js';
import { lastAssistantMessage } from '../session/query.js';
import type { SessionMessage } from '../session/types.js';
import { scanSkills } from '../skills/scan.js';
import { EXPLORE_TOOLS, PLAN_TOOLS, READ_TOOLS, findTool, openaiTools } from '../tools/index.js';
import type { ToolContext } from '../tools/types.js';

/** 并行 subagent 上限：fan-out 调研的常见 sweet spot，超出排队而非拒绝。 */
const SUBAGENT_CONCURRENCY = 4;
const MAX_STEPS = 32;

/**
 * 事件 id 用进程内单调序号。
 * 旧实现用 `Date.now()`：同一毫秒内连续发出多个 ask/thinking_start 事件会撞号，
 * 消费端（TUI）按 id 配对 start/end 时会串台。
 */
let eventSeq = 0;
function nextEventId(prefix: string): string {
  return `${prefix}-${++eventSeq}`;
}

export interface RunTurnOptions {
  prompt: string;
  workspaceRoot: string;
  client: LlmClient;
  session: JsonlSession;
  sandbox: SandboxHandle;
  approver: Approver;
  contextWindow: number;
  listener?: AgentListener;
  signal?: AbortSignal;
  mcp?: McpHub;
  todos?: TodoList;
  jobs?: JobBoard;
  persistent?: PersistentShell;
  depth?: number;
  allowedTools?: ReadonlySet<string>;
  /** plan mode 状态；headless 不传即不启用。 */
  planState?: { sessionMode: 'default' | 'plan'; exitPlan(): void };
  /** 用户随本条 prompt 提交的图片（data URL）。 */
  userImages?: string[];
  memory?: TouchMemory;
  /** 跨轮次任务目标（来自会话折叠）；注入系统提示词。 */
  goal?: string;
  /** 上一次工具失败（来自会话折叠）；注入系统提示词，避免恢复后重蹈覆辙。 */
  lastFailure?: SessionFailure;
  /** 超长工具结果落盘。未提供则所有结果原样进上下文（测试与库调用默认如此）。 */
  spill?: SpillStore;
  /** 压缩摘要专用 client（配置了 compact_model 时）；省略用主 client。 */
  compactClient?: LlmClient;
  /** 辅助调用（压缩）产生的用量回调，用于记账但不参与上下文水位。 */
  onAuxUsage?: (usage: TokenUsage, purpose: string) => void;
}

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

export async function runTurn(options: RunTurnOptions): Promise<void> {
  const depth = options.depth ?? 0;
  const skills = scanSkills(options.workspaceRoot);
  for (const warning of skills.warnings) options.listener?.({ type: 'status', text: warning });
  const todos = options.todos ?? new TodoList();
  const jobs = options.jobs ?? new JobBoard(options.sandbox);
  const persistent = options.persistent ?? new PersistentShell(options.sandbox, options.workspaceRoot);
  const mcp = options.mcp ?? new McpHub();
  const memory = options.memory ?? new TouchMemory(options.workspaceRoot);
  const planState = options.planState;

  const system = buildSystemPrompt({
    workspaceRoot: options.workspaceRoot,
    sandbox: options.sandbox.status.mode,
    skills: skills.catalog,
    mcpTools: mcp.listTools(),
    persistent: persistent.confined ? 'confined-oneshot' : 'long-lived',
    planMode: planState?.sessionMode === 'plan',
    goal: options.goal,
    lastFailure: options.lastFailure,
  });
  options.session.appendMessage({ role: 'user', content: options.prompt, images: options.userImages });
  options.session.append({
    type: 'event',
    ts: new Date().toISOString(),
    kind: 'turn_start',
    data: { depth, sandbox: options.sandbox.status.mode, plan: planState?.sessionMode === 'plan' },
  });

  // 会话镜像：turn 内所有投影走内存，避免每个 step 重读 JSONL。
  const mirror: SessionMessage[] = options.session.readMessages();
  let compaction: CompactionEvent | undefined = loadCompaction(options.session);
  let lastUsage: TokenUsage | undefined;
  /** lastUsage 覆盖到的镜像位置：之后追加的消息没算进那份 prompt，估算时要补上。 */
  let usageAnchor = mirror.length;
  /** todo 上次落盘的样子：只有真的变了才写事件，避免每步都往 JSONL 塞一份重复快照。 */
  let todoSnapshot = JSON.stringify(todos.list());
  const appendMessage = (message: Omit<SessionMessage, 'type' | 'ts'>): void => {
    options.session.appendMessage(message);
    mirror.push({ type: 'message', ts: new Date().toISOString(), ...message });
  };

  const subagentSlots = new Semaphore(SUBAGENT_CONCURRENCY);
  const runChild = async (input: {
    prompt: string;
    type: 'explore' | 'general';
    signal?: AbortSignal;
  }): Promise<string> => {
    if (depth >= 1) return 'nested subagent denied';
    const childSession = createSession(options.session.dir, options.workspaceRoot, false);
    const allowed = input.type === 'explore' ? EXPLORE_TOOLS : undefined;
    await runTurn({
      prompt: input.prompt,
      workspaceRoot: options.workspaceRoot,
      client: options.client,
      session: childSession,
      sandbox: options.sandbox,
      approver: options.approver,
      contextWindow: options.contextWindow,
      listener: options.listener,
      signal: input.signal ?? options.signal,
      mcp,
      todos,
      jobs,
      persistent,
      memory,
      depth: depth + 1,
      allowedTools: allowed,
    });
    const last = lastAssistantMessage(childSession.readMessages());
    return last?.content || '(subagent produced no assistant text)';
  };

  const ctx: ToolContext = {
    workspaceRoot: options.workspaceRoot,
    sandboxMode: options.sandbox.status.mode,
    signal: options.signal,
    skills: skills.catalog,
    todos,
    jobs,
    persistent,
    mcp,
    async runShell(command, timeoutMs) {
      const shell = resolveShellBinary();
      return options.sandbox.run({
        command: shell.command,
        args: [...shell.prefixArgs, command],
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
    async escalateReadOnlyWrite(path) {
      options.listener?.({
        type: 'ask',
        id: nextEventId('ask'),
        tool: 'escalate',
        detail: `run this write at workspace sandbox: ${path}`,
      });
      return options.approver.decide({ tool: 'escalate', path });
    },
    async exitPlan(plan) {
      const outcome = options.approver.decidePlan
        ? await options.approver.decidePlan(plan)
        : { approved: false, feedback: 'no plan approver in this mode' };
      if (outcome.approved) planState?.exitPlan();
      return outcome;
    },
    noteMemoryTouch(absPath) {
      memory.noteTouch(absPath);
    },
    spillRoot: options.spill?.root,
    async spawnSubagent(input) {
      if (input.background) {
        return jobs.startTask(input.description ?? input.prompt.slice(0, 60), (signal) =>
          runChild({ prompt: input.prompt, type: input.type, signal }),
        );
      }
      const release = await subagentSlots.acquire();
      try {
        return await runChild(input);
      } finally {
        release();
      }
    },
  };

  const allowed = options.allowedTools;
  const planBlocked = (name: string): boolean =>
    planState?.sessionMode === 'plan' && !PLAN_TOOLS.has(name);

  for (let step = 0; step < MAX_STEPS; step++) {
    if (options.signal?.aborted) throw new Error('aborted');

    // 触碰到的嵌套指令在进入下一次 LLM 请求前入列。
    for (const touch of memory.drain()) {
      appendMessage({ role: 'user', content: `[instructions from ${touch.relPath}]\n${touch.text}` });
    }

    // 投影 + 压缩落盘集中一处：超限重试要再走一遍同样的流程。
    const buildProjection = async (force: boolean): Promise<ChatMessage[]> => {
      const auxUsage = options.onAuxUsage;
      const projection = await projectContext({
        messages: mirror,
        compaction,
        contextWindow: options.contextWindow,
        // 摘要可以走便宜的小模型：它只读不写，且输出格式固定，是最典型的降本点。
        client: options.compactClient ?? options.client,
        signal: options.signal,
        lastUsage,
        lastUsageAnchor: usageAnchor,
        force,
        system,
        ...(auxUsage ? { onUsage: (usage: TokenUsage) => auxUsage(usage, 'compaction') } : {}),
      });
      if (projection.compaction) {
        const next = projection.compaction;
        if (next.covered !== (compaction?.covered ?? 0)) {
          options.session.append({
            type: 'event',
            ts: new Date().toISOString(),
            kind: 'compaction',
            data: { summary: next.summary, covered: next.covered },
          });
          compaction = next;
          options.listener?.({ type: 'status', text: `context compacted (${next.covered} messages summarized)` });
        }
      }
      return projection.messages;
    };

    let projected = await buildProjection(false);

    const streamed = { text: false, thinking: false };
    // 思考开始先广播，消费端才能把 thinking 段与正文分开；complete 内部不区分思考/正文增量。
    const thinkingId = nextEventId('thinking');
    options.listener?.({ type: 'thinking_start', id: thinkingId });
    let reply: Awaited<ReturnType<RunTurnOptions['client']['complete']>>;
    let anchorAt = mirror.length;
    // provider 判定超窗时压缩后重试一次。上限 1 次：再失败说明单轮内容本身就超窗，
    // 重试只会再烧一次调用。已经给用户看过正文**或思考链**时绝不重试，否则会看到重复内容。
    let overflowRetried = false;
    for (;;) {
      anchorAt = mirror.length;
      try {
        reply = await options.client.complete(
          projected,
          openaiTools(allowed),
          options.signal,
          (delta) => {
            if (delta.thinking) {
              streamed.thinking = true;
              options.listener?.({ type: 'thinking_delta', id: thinkingId, text: delta.thinking });
            }
            if (delta.text) {
              streamed.text = true;
              options.listener?.({ type: 'text', text: delta.text });
            }
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
    // 思考结束在正文之后广播：消费端完成 thinking 段与正文的分段展示。
    options.listener?.({ type: 'thinking_end', id: thinkingId, content: reply.thinking ?? '' });
    if (reply.text && !streamed.text) options.listener?.({ type: 'text', text: reply.text });
    if (reply.usage) {
      lastUsage = reply.usage;
      usageAnchor = anchorAt;
      options.session.append({
        type: 'event',
        ts: new Date().toISOString(),
        kind: 'usage',
        data: { ...reply.usage },
      });
      options.listener?.({
        type: 'usage',
        promptTokens: reply.usage.promptTokens,
        completionTokens: reply.usage.completionTokens,
        ...(reply.usage.cachedTokens === undefined ? {} : { cachedTokens: reply.usage.cachedTokens }),
      });
    }

    if (!reply.toolCalls?.length) {
      appendMessage({ role: 'assistant', content: reply.text ?? '' });
      options.session.append({
        type: 'event',
        ts: new Date().toISOString(),
        kind: 'turn_end',
        data: { depth },
      });
      options.listener?.({ type: 'done' });
      return;
    }

    const parsedCalls = reply.toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: parseArgs(call.arguments),
    }));
    appendMessage({
      role: 'assistant',
      content: reply.text ?? '',
      toolCalls: parsedCalls,
    });

    const reads = parsedCalls.filter((call) => READ_TOOLS.has(call.name));
    const writes = parsedCalls.filter((call) => !READ_TOOLS.has(call.name));

    // 拒绝理由集中在一处判定：runOne 只负责执行与回写，可读性比嵌套 if/else 好。
    const denyReason = (name: string): string | undefined => {
      if (allowed && !allowed.has(name)) return `tool not allowed in this agent: ${name}`;
      if (!findTool(name)) return `unknown tool: ${name}`;
      if (planBlocked(name)) {
        return 'plan mode is active: only read-only tools work. Research more, then call exit_plan_mode with your plan.';
      }
      return undefined;
    };

    const runOne = async (call: (typeof parsedCalls)[number]) => {
      options.listener?.({ type: 'tool_start', name: call.name, id: call.id, args: call.arguments });
      const tool = findTool(call.name);
      const denied = denyReason(call.name);
      let result;
      try {
        if (denied || !tool) result = { ok: false, content: denied ?? `unknown tool: ${call.name}` };
        else result = await tool.execute(call.arguments, ctx);
      } catch (error) {
        result = { ok: false, content: error instanceof Error ? error.message : String(error) };
      }
      // 超长结果落盘：上下文里只留头尾预览 + 绝对路径。写盘失败时 persist 返回 undefined，
      // 此时保留原文——spill 是优化，不能变成结果丢失的原因。
      if (options.spill && result.ok && !result.images?.length) {
        const spilled = options.spill.persist(call.name, result.content);
        if (spilled !== undefined) result = { ...result, content: spilled };
      }
      appendMessage({
        role: 'tool',
        content: result.content,
        toolCallId: call.id,
        toolName: call.name,
        images: result.images,
      });
      // 失败历史落盘：成功对恢复没有价值，失败能让恢复后的模型知道上次卡在哪。
      if (!result.ok) {
        options.session.append({
          type: 'event',
          ts: new Date().toISOString(),
          kind: 'tool_result',
          data: sessionEventData.toolFailure(call.name, result.content),
        });
      }
      options.listener?.({ type: 'tool_end', name: call.name, id: call.id, ok: result.ok, content: result.content });
    };

    await Promise.all(reads.map(runOne));
    for (const call of writes) await runOne(call);

    const nextTodos = JSON.stringify(todos.list());
    if (nextTodos !== todoSnapshot) {
      todoSnapshot = nextTodos;
      options.session.append({
        type: 'event',
        ts: new Date().toISOString(),
        kind: 'todo',
        data: sessionEventData.todo(todos.list()),
      });
    }
  }
  throw new Error(`tool loop exceeded ${MAX_STEPS} steps`);
}
