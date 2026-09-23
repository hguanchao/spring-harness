/**
 * `subagent` 与 `send_subagent_message`。
 *
 * 工具只做一件事：把模型给的 agent 名字解析成一份定义，然后交给宿主的
 * spawnSubagent。子会话、深度预算、审批、事件协议都在 loop 里，插件不复制那一套。
 */
import { asOptionalBool, asString, clip, SUBAGENT_CONCURRENCY, type ToolContext, type ToolResult, type ToolSpec } from '../../tools/types.js';
import { findAgent, type AgentDefinition } from './agents.js';

export function subagentToolPrompt(): string {
  return [
    'Use subagent to fan out independent work. Give every call a description of 3-5 words — it is the only label the user sees on that row.',
    'agent names a definition: built-in explore (read-only) and general (can edit), plus any markdown file in ~/.sph/agents or the workspace .sph/agents.',
    'Start independent delegations in one assistant message so they run together.',
    'background: true is only for fire-and-forget chores whose result this reply does not depend on; you are notified on completion.',
    'Set background false (the default) when your next action needs the child\'s report.',
  ].join(' ');
}

export function createSubagentTool(loadAgents: () => readonly AgentDefinition[]): ToolSpec {
  return {
    name: 'subagent',
    description:
      `Run a child agent with its own session and block until it finishes — its final report comes back as this tool's result. Use it for work that genuinely benefits from a separate context — broad exploration, an independent chunk of implementation — not for something one or two of your own tool calls would settle. The child sees only your prompt plus its own findings, so give it a complete, self-contained task. Use this whenever your answer depends on the child's findings, and send several subagent calls in the same reply to run them in parallel (up to ${SUBAGENT_CONCURRENCY}). Nesting is flat by default (depth 1): a subagent cannot spawn its own subagents, and a call beyond the configured depth budget fails with an explicit depth error. agent names a definition (built-in: explore, general); its tools and prompt come from that definition. background: true is ONLY for fire-and-forget chores whose result your reply does not depend on — it returns a job id immediately and you will be notified automatically when it completes; use jobs(action:get) for a status snapshot only. Long-running work goes here, not through a background shell. isolation: worktree runs the child in an isolated git worktree (its result reports the path). resume_from: pass a completed subagent's session id to continue its conversation.`,
    concurrencySafe: true,
    prompt: subagentToolPrompt(),
    schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The full task prompt for the subagent to execute.' },
        agent: { type: 'string', description: 'Agent definition name. Built-in: explore (read-only) or general (can edit). Defaults to general.' },
        background: { type: 'boolean', description: 'Run detached and return a job id instead of blocking' },
        description: {
          type: 'string',
          description: 'Short description of the task (3-5 words). Shown as the subagent row label.',
        },
        isolation: { type: 'string', enum: ['none', 'worktree'], description: 'worktree runs the child in an isolated git worktree' },
        resume_from: { type: 'string', description: 'Subagent session id to continue a completed subagent conversation' },
      },
      required: ['prompt', 'description'],
    },
    async execute(args, ctx: ToolContext, callId?: string): Promise<ToolResult> {
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
      id: { type: 'string', description: 'Target subagent session id (from the subagent result footer or jobs output)' },
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
        content: `subagent ${id} already completed — spawn a new subagent with resume_from: "${id}" instead`,
      };
    }
    return { ok: false, content: `subagent ${id} not found or not addressable (only running background subagents can receive messages)` };
  },
};
