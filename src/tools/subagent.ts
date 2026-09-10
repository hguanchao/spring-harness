import { asOptionalBool, asString, type ToolContext, type ToolResult, type ToolSpec } from './types.js';

export const subagentTool: ToolSpec = {
  name: 'subagent',
  description:
    'Run a child agent with its own session. type: explore (read-only tools) or general (can edit). background: true returns a job id immediately — poll it with jobs(action:get); up to 4 subagents run in parallel.',
  schema: {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
      type: { type: 'string', enum: ['explore', 'general'] },
      background: { type: 'boolean', description: 'Run detached and return a job id instead of blocking' },
      description: { type: 'string', description: 'Short label shown in the jobs list' },
    },
    required: ['prompt'],
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const prompt = asString(args, 'prompt');
    const type = args.type === 'explore' ? 'explore' : 'general';
    const background = asOptionalBool(args, 'background');
    const description = typeof args.description === 'string' ? args.description.slice(0, 120) : undefined;
    const text = await ctx.spawnSubagent({ prompt, type, background, description });
    return { ok: true, content: text };
  },
};
