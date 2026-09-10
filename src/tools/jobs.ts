import { asString, clip, type ToolContext, type ToolResult, type ToolSpec } from './types.js';

export const jobsTool: ToolSpec = {
  name: 'jobs',
  description: 'Start or inspect background shell jobs. action: start | list | get.',
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['start', 'list', 'get'] },
      command: { type: 'string' },
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
    if (action === 'start') {
      const command = asString(args, 'command');
      const allowed = await ctx.approve('shell', command);
      if (!allowed) return { ok: false, content: 'jobs start denied' };
      const { resolveShellBinary } = await import('../sandbox/shell-bin.js');
      const shell = resolveShellBinary();
      const id = ctx.jobs.start(command, {
        command: shell.command,
        args: [...shell.prefixArgs, command],
        cwd: ctx.workspaceRoot,
      });
      return { ok: true, content: `started ${id}` };
    }
    return { ok: false, content: `unknown action: ${action}` };
  },
};
