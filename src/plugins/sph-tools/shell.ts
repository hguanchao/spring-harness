import { errorMessage } from '../../util.js';
import { asString, clip, type ToolContext, type ToolResult, type ToolSpec } from '../../tools/types.js';

const DEFAULT_TIMEOUT_MS = 60_000;

function makeShellTool(kind: 'bash' | 'pwsh', description: string): ToolSpec {
  return {
    name: kind,
    description,
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
      const allowed = await ctx.approve(kind, command);
      if (!allowed) {
        return {
          ok: false,
          content: `${kind} denied by the approval policy (a deny rule, the approval mode, or the user) — do not retry it by another route`,
        };
      }
      const timeout = typeof args.timeout_ms === 'number' && args.timeout_ms > 0
        ? Math.min(args.timeout_ms, 5 * 60_000)
        : DEFAULT_TIMEOUT_MS;
      try {
        const result = await ctx.runShell(command, timeout, kind);
        const body = [
          `exit ${result.exitCode ?? 'timeout'}`,
          result.stdout ? `stdout:\n${clip(result.stdout)}` : 'stdout: (empty)',
          result.stderr ? `stderr:\n${clip(result.stderr)}` : '',
        ].filter(Boolean).join('\n');
        return { ok: result.exitCode === 0, content: body };
      } catch (error) {
        return { ok: false, content: errorMessage(error) };
      }
    },
  };
}

export const bashTool: ToolSpec = makeShellTool(
  'bash',
  'Run a POSIX shell command in the workspace root via bash (on Windows that means Git Bash: on PATH or beside the git executable).'
    + ' Each call is one-shot: no cwd, variable, or function survives between calls, so pass explicit paths'
    + ' instead of relying on an earlier cd. Check the exit-code marker on every result before moving on.'
    + ' A write denied by the workspace sandbox is policy, not a command bug: restate the path inside the'
    + ' workspace rather than reaching for another way to write it.',
);

export const pwshTool: ToolSpec = makeShellTool(
  'pwsh',
  'Run a PowerShell command in the workspace root via pwsh (Windows PowerShell if pwsh is missing).'
    + ' Each call is one-shot: no cwd, variable, or function survives between calls, so pass explicit paths'
    + ' instead of relying on an earlier cd. Check the exit-code marker on every result before moving on.'
    + ' Prefer npm.cmd / npx.cmd / node over bare npm / npx so PowerShell does not resolve .ps1 shims.'
    + ' A write denied by the workspace sandbox is policy, not a command bug: restate the path inside the'
    + ' workspace rather than reaching for another way to write it.',
);
