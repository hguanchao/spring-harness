import type { Approver } from '../approval/policy.js';
import { loadCompaction, projectContext, type CompactionEvent } from './compact.js';
import type { AgentListener } from './events.js';
import { TouchMemory } from './memory.js';
import { buildSystemPrompt } from './prompt.js';
import type { LlmClient, TokenUsage } from '../llm/openai.js';
import { McpHub } from '../mcp/hub.js';
import { JobBoard } from '../runtime/jobs.js';
import { PersistentShell } from '../runtime/persistent-shell.js';
import { TodoList } from '../runtime/todos.js';
import type { SandboxHandle } from '../sandbox/open.js';
import { resolveShellBinary } from '../sandbox/shell-bin.js';
import { createSession, type JsonlSession } from '../session/store.js';
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

    const projection = await projectContext({
      messages: mirror,
      compaction,
      contextWindow: options.contextWindow,
      client: options.client,
      signal: options.signal,
      lastUsage,
      system,
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

    const streamed = { text: false };
    // 思考开始先广播，消费端才能把 thinking 段与正文分开；complete 内部不区分思考/正文增量。
    const thinkingId = nextEventId('thinking');
    options.listener?.({ type: 'thinking_start', id: thinkingId });
    let reply: Awaited<ReturnType<RunTurnOptions['client']['complete']>>;
    try {
      reply = await options.client.complete(
        projection.messages,
        openaiTools(allowed),
        options.signal,
        (delta) => {
          if (delta.text) {
            streamed.text = true;
            options.listener?.({ type: 'text', text: delta.text });
          }
        },
      );
    } catch (error) {
      // 思考中途失败：补发 end 信号，防止消费端卡在 running 态。
      options.listener?.({ type: 'thinking_end', id: thinkingId, content: '' });
      throw error;
    }
    // 思考结束在正文之后广播：消费端完成 thinking 段与正文的分段展示。
    options.listener?.({ type: 'thinking_end', id: thinkingId, content: reply.thinking ?? '' });
    if (reply.text && !streamed.text) options.listener?.({ type: 'text', text: reply.text });
    if (reply.usage) {
      lastUsage = reply.usage;
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
      appendMessage({
        role: 'tool',
        content: result.content,
        toolCallId: call.id,
        toolName: call.name,
        images: result.images,
      });
      options.listener?.({ type: 'tool_end', name: call.name, id: call.id, ok: result.ok, content: result.content });
    };

    await Promise.all(reads.map(runOne));
    for (const call of writes) await runOne(call);
  }
  throw new Error(`tool loop exceeded ${MAX_STEPS} steps`);
}
