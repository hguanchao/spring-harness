/**
 * `task` 与 `send_subagent_message`。
 *
 * spawn 只做一件事：把模型给的 agent 名字解析成一份定义，然后交给宿主的
 * spawnSubagent。list / get 只读后台记录。子会话、深度预算、审批、事件协议都在
 * loop 里，插件不复制那一套。
 */
import { asOptionalBool, asString, clip, SUBAGENT_CONCURRENCY, type ToolContext, type ToolResult, type ToolSpec } from '../../tools/types.js';
import { findAgent, type AgentDefinition } from './agents.js';

export function taskToolPrompt(): string {
  return [
    'Use task to start work and to look up work already running. A question one or two of your own tool calls would settle is yours — do not delegate it. Give every spawned task a description of 3-5 words — it is the only label the user sees on that row.',
    'Write the prompt as a brief to another agent: the question, what you already know, and what "done" looks like. The child does not see this conversation, and its final message is the only thing you get back.',
    'Fan out only slices that do not depend on each other and that each have their own stopping point. An open-ended survey of the whole project is one child, or your own reads — three unbounded slices run three times and still may not finish.',
    'agent names a definition: built-in explore and research (read-only), writer (documents only), and general (can edit and run commands), plus any markdown file in ~/.sph/agents or the workspace .sph/agents.',
    'Start independent delegations in one assistant message so they run together.',
    'background: true is only for fire-and-forget chores whose result this reply does not depend on; you are notified on completion.',
    'Set background false (the default) when your next action needs the child\'s report.',
    'action list and action get only re-read a background record. Completion arrives as a notification, so do not poll.',
    'action cancel stops background work you no longer need (wrong direction, superseded, runaway). The child stops at its next safe point and the cancellation arrives as a notification — do not wait for it.',
  ].join(' ');
}

export function createTaskTool(loadAgents: () => readonly AgentDefinition[]): ToolSpec {
  return {
    name: 'task',
  description:
    `Start a child agent, or inspect background work you already started. action spawn (the default) runs a child with its own session and blocks until it finishes — its final report comes back as this tool's result. Use spawn for work that genuinely benefits from a separate context — a bounded question, an independent chunk of implementation — not for something one or two of your own tool calls would settle, and not to split one open-ended survey into several unbounded slices. The child sees only your prompt plus its own findings, so name the question, what you already know, and what done looks like. Use spawn whenever your answer depends on the child's findings, and send several task calls in the same reply to run them in parallel (up to ${SUBAGENT_CONCURRENCY}). Nesting is flat by default (depth 1): a subagent cannot spawn its own subagents, and a call beyond the configured depth budget fails with an explicit depth error. agent names a definition (built-in: explore, research, writer, general); its tools and prompt come from that definition. background: true is ONLY for fire-and-forget chores whose result your reply does not depend on — it returns a task id immediately and you are notified when it completes. action list and action get only re-read that record; completion already arrives as a notification, so do not poll. action cancel aborts background work still running — the child stops at its next safe point and a cancellation notification follows; its session stays resumable. Long-running work goes here, not through a background shell. isolation: worktree runs the child in an isolated git worktree (its result reports the path). resume_from: pass a completed subagent's session id to continue its conversation.`,
    concurrencySafe: true,
    prompt: taskToolPrompt(),
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['spawn', 'list', 'get', 'cancel'], description: 'spawn (default) starts a child agent. list and get inspect background work already started. cancel stops background work still running.' },
        prompt: { type: 'string', description: 'The full task prompt for the subagent to execute. Required for spawn.' },
        agent: { type: 'string', description: 'Agent definition name. Built-in: explore, research (both read-only), writer (documents), or general (can edit and run commands). Defaults to general.' },
        background: { type: 'boolean', description: 'Run detached and return a job id instead of blocking' },
        description: {
          type: 'string',
          description: 'Short description of the task (3-5 words). Shown as the subagent row label.',
        },
        isolation: { type: 'string', enum: ['none', 'worktree'], description: 'worktree runs the child in an isolated git worktree' },
        resume_from: { type: 'string', description: 'Subagent session id to continue a completed subagent conversation' },
        id: { type: 'string', description: 'Background task id for action get / cancel' },
      },
      required: ['description'],
    },
    async execute(args, ctx: ToolContext, callId?: string): Promise<ToolResult> {
      const action = typeof args.action === 'string' && args.action !== '' ? args.action : 'spawn';
      if (action === 'list') return { ok: true, content: clip(JSON.stringify(ctx.jobs.list(), null, 2)) };
      if (action === 'get') {
        const job = ctx.jobs.get(asString(args, 'id'));
        if (!job) return { ok: false, content: 'task not found' };
        return { ok: true, content: clip(JSON.stringify(job, null, 2)) };
      }
      if (action === 'cancel') {
        const id = asString(args, 'id');
        const outcome = ctx.jobs.abort(id);
        if (outcome === 'not_found') return { ok: false, content: `task not found: ${id}` };
        if (outcome === 'done') return { ok: false, content: `task ${id} already completed — nothing to cancel` };
        // 取消是异步生效的：信号已发，真正的停止以 CANCELLED 通知为准。
        return { ok: true, content: `cancel signal sent to task ${id} — it stops at its next safe point; a notification will confirm` };
      }
      if (action !== 'spawn') return { ok: false, content: `unknown action: ${action}` };
      const prompt = asString(args, 'prompt');
      const rawIsolation = args.isolation;
      if (rawIsolation !== undefined && rawIsolation !== 'none' && rawIsolation !== 'worktree') {
        return { ok: false, content: `isolation must be "none" or "worktree" (got ${JSON.stringify(rawIsolation)})` };
      }
      const requested = typeof args.agent === 'string' && args.agent.trim() !== '' ? args.agent.trim() : 'general';
      const agent = findAgent(loadAgents(), requested);
      if (!agent) {
        const names = loadAgents().map((item) => item.name).join(', ');
        return { ok: false, content: `unknown agent "${requested}". Available: ${names}` };
      }
      const background = asOptionalBool(args, 'background');
      const description = typeof args.description === 'string' ? args.description.slice(0, 120) : undefined;
      const isolation = rawIsolation === 'worktree' ? 'worktree' as const : 'none' as const;
      const resumeFrom = typeof args.resume_from === 'string' && args.resume_from.trim() !== ''
        ? args.resume_from.trim()
        : undefined;
      const text = await ctx.spawnSubagent({
        prompt,
        agent: agent.name,
        tools: agent.tools,
        systemPrompt: agent.systemPrompt,
        background,
        description,
        isolation,
        resumeFrom,
        toolCallId: callId,
      });
      return { ok: true, content: text };
    },
  };
}

export const sendSubagentMessageTool: ToolSpec = {
  name: 'send_subagent_message',
  description:
    "Send a message to a RUNNING background subagent you own, addressed by its subagent session id. The message is delivered at the subagent's next safe point (steer). Root session only — subagents cannot message each other. If the target already completed, the call fails: spawn a new subagent with resume_from instead.",
  prompt:
    'Use send_subagent_message to steer a background subagent that is still running. It is delivered at the next safe point, not mid-call.',
  rootOnly: true,
  schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Target subagent session id (from the task result footer or task(action: get))' },
      message: { type: 'string', description: 'Message text delivered to the subagent as a user message' },
    },
    required: ['id', 'message'],
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const id = asString(args, 'id');
    const message = asString(args, 'message');
    const outcome = ctx.sendToSubagent(id, clip(message));
    if (outcome === 'queued') return { ok: true, content: `message queued for delivery to subagent ${id}` };
    if (outcome === 'completed') {
      return {
        ok: false,
        content: `subagent ${id} already completed — start a new task with resume_from: "${id}" instead`,
      };
    }
    return { ok: false, content: `subagent ${id} not found or not addressable (only running background subagents can receive messages)` };
  },
};
