import { asString, clip, type ToolContext, type ToolResult, type ToolSpec } from './types.js';

const DEFAULT_TIMEOUT_MS = 60_000;

export const shellTool: ToolSpec = {
  name: 'shell',
  description:
    'Run a shell command in the workspace root — pwsh on Windows, sh elsewhere, so bash-only syntax may not apply.'
    + ' Each call is one-shot: no cwd, variable, or function survives between calls, so pass explicit paths'
    + ' instead of relying on an earlier cd. Check the exit-code marker on every result before moving on.'
    + ' A write denied by the workspace sandbox is policy, not a command bug: restate the path inside the'
    + ' workspace rather than reaching for another way to write it.',
  schema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      timeout_ms: { type: 'integer' },
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
    const result = await ctx.runShell(command, timeout);
    const body = [
      `exit ${result.exitCode ?? 'timeout'}`,
      result.stdout ? `stdout:\n${clip(result.stdout)}` : 'stdout: (empty)',
      result.stderr ? `stderr:\n${clip(result.stderr)}` : '',
    ].filter(Boolean).join('\n');
    return { ok: result.exitCode === 0, content: body };
  },
};
