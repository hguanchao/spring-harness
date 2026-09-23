import { asString, clip, type ToolContext, type ToolResult, type ToolSpec } from '../../tools/types.js';

export const jobsTool: ToolSpec = {
  name: 'jobs',
  description: 'Inspect background work you already started. action: list | get. Completion arrives as a notification, so do not poll or sleep-wait — use this only to check status or re-read a result. It does not start work; that is subagent(background: true).',
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'get'] },
      id: { type: 'string' },
    },
    required: ['action'],
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const action = asString(args, 'action');
    if (action === 'list') return { ok: true, content: clip(JSON.stringify(ctx.jobs.list(), null, 2)) };
    if (action === 'get') {
      const job = ctx.jobs.get(asString(args, 'id'));
      if (!job) return { ok: false, content: 'job not found' };
      return { ok: true, content: clip(JSON.stringify(job, null, 2)) };
    }
    return { ok: false, content: `unknown action: ${action}` };
  },
};
