import { asString, clip, type ToolContext, type ToolResult, type ToolSpec } from './types.js';

const DEFAULT_TIMEOUT_MS = 60_000;

export const shellTool: ToolSpec = {
  name: 'shell',
  description:
    'Run a PowerShell command in the workspace root. On Windows this is pwsh, not bash. Writes outside the workspace fail under the workspace sandbox (partial OS enforcement).',
  schema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      timeout_ms: { type: 'integer' },
      persistent: { type: 'boolean', description: 'Reuse a long-lived shell. Only when sandbox is off.' },
    },
    required: ['command'],
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const command = asString(args, 'command');
    const allowed = await ctx.approve('shell', command);
    if (!allowed) return { ok: false, content: 'shell denied (headless requires --yolo; interactive requires approval)' };
    const timeout = typeof args.timeout_ms === 'number' && args.timeout_ms > 0
      ? Math.min(args.timeout_ms, 5 * 60_000)
      : DEFAULT_TIMEOUT_MS;
    const persistent = args.persistent === true;
    const result = persistent
      ? await ctx.persistent.exec(command, timeout)
      : await ctx.runShell(command, timeout);
    const body = [
      `exit ${result.exitCode ?? 'timeout'}`,
      result.stdout ? `stdout:\n${clip(result.stdout)}` : 'stdout: (empty)',
      result.stderr ? `stderr:\n${clip(result.stderr)}` : '',
    ].filter(Boolean).join('\n');
    return { ok: result.exitCode === 0, content: body };
  },
};
