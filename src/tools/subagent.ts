import { asOptionalBool, asString, SUBAGENT_CONCURRENCY, type ToolContext, type ToolResult, type ToolSpec } from './types.js';

export const subagentTool: ToolSpec = {
  name: 'subagent',
  description:
    `Run a child agent with its own session and block until it finishes — its final report comes back as this tool's result. Use it for work that genuinely benefits from a separate context — broad exploration, an independent chunk of implementation — not for something one or two of your own tool calls would settle. The child sees only your prompt plus its own findings, so give it a complete, self-contained task. Use this whenever your answer depends on the child's findings, and send several subagent calls in the same reply to run them in parallel (up to ${SUBAGENT_CONCURRENCY}). Nesting is flat by default (depth 1): a subagent cannot spawn its own subagents, and a call beyond the configured depth budget fails with an explicit depth error. type: explore (read-only tools) or general (can edit). background: true is ONLY for fire-and-forget chores whose result your reply does not depend on — it returns a job id immediately and you will be notified automatically when it completes; use jobs(action:get) for a status snapshot only. Long-running work goes here, not through a background shell. isolation: worktree runs the child in an isolated git worktree (its result reports the path). resume_from: pass a completed subagent's session id to continue its conversation.`,
  schema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'The full task prompt for the subagent to execute.' },
      type: { type: 'string', enum: ['explore', 'general'] },
      background: { type: 'boolean', description: 'Run detached and return a job id instead of blocking' },
      description: {
        type: 'string',
        description: 'Short description of the task (3-5 words). Shown as the subagent row label.',
      },
      isolation: { type: 'string', enum: ['none', 'worktree'], description: 'worktree runs the child in an isolated git worktree' },
      resume_from: { type: 'string', description: 'Subagent session id to continue a completed subagent conversation' },
    },
    // description 必填（对齐参考实现）：它是界面上那一行的唯一可读标签，缺失时只能拿 prompt
    // 顶上，而 prompt 是整段任务书——印出来就是一堵墙。3-5 个词才读得出来。
    required: ['prompt', 'description'],
  },
  async execute(args, ctx: ToolContext, callId?: string): Promise<ToolResult> {
    const prompt = asString(args, 'prompt');
    const type = args.type === 'explore' ? 'explore' : 'general';
    const background = asOptionalBool(args, 'background');
    const description = typeof args.description === 'string' ? args.description.slice(0, 120) : undefined;
    const isolation = args.isolation === 'worktree' ? 'worktree' as const : 'none' as const;
    const resumeFrom = typeof args.resume_from === 'string' && args.resume_from.trim() !== '' ? args.resume_from.trim() : undefined;
    const text = await ctx.spawnSubagent({ prompt, type, background, description, isolation, resumeFrom, toolCallId: callId });
    return { ok: true, content: text };
  },
};
