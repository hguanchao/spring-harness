import { errorMessage } from '../../util.js';
import { asString, clip, type ToolContext, type ToolResult, type ToolSpec } from '../../tools/types.js';

const DEFAULT_TIMEOUT_MS = 60_000;
/** 前台和后台都卡在这里：再长会把已经批准的回合挂死。 */
const MAX_TIMEOUT_MS = 5 * 60_000;

/**
 * 模型可以要求更长，但超过上限就缩短。缩短必须写进结果，否则它以为自己拿到了请求的时长。
 * 非正数按缺省处理，和没写 timeout_ms 一样。
 */
function shellTimeout(requested: unknown): { ms: number; note: string } {
  if (typeof requested !== 'number' || !(requested > 0)) {
    return { ms: DEFAULT_TIMEOUT_MS, note: '' };
  }
  if (requested <= MAX_TIMEOUT_MS) return { ms: requested, note: '' };
  return {
    ms: MAX_TIMEOUT_MS,
    note: `timeout_ms ${requested} was capped at ${MAX_TIMEOUT_MS}`,
  };
}

function shellBody(
  result: { stdout: string; stderr: string; exitCode: number | null },
  note: string,
): string {
  return [
    note,
    `exit ${result.exitCode ?? 'timeout'}`,
    result.stdout ? `stdout:\n${clip(result.stdout)}` : 'stdout: (empty)',
    result.stderr ? `stderr:\n${clip(result.stderr)}` : '',
  ].filter((line) => line !== '').join('\n');
}

function makeShellTool(kind: 'bash' | 'pwsh', description: string): ToolSpec {
  return {
    name: kind,
    description: `${description} timeout_ms is capped at ${MAX_TIMEOUT_MS}; a larger request is shortened and the result says so.`,
    schema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout_ms: { type: 'integer' },
        background: { type: 'boolean', description: 'Start the command and return a task id. Completion arrives as a notification; task(action: get) re-reads it.' },
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
      const timeout = shellTimeout(args.timeout_ms);
      if (args.background === true) {
        // 不把本轮的取消信号传进去：后台命令要活过这次工具调用。进程退出走任务板的 abort。
        const id = ctx.jobs.startTask(`${kind}: ${command}`, async () => {
          const result = await ctx.runShell(command, timeout.ms, kind);
          const body = shellBody(result, timeout.note);
          if (result.exitCode !== 0) throw new Error(body);
          return body;
        }, 'shell');
        const started = `background ${kind} started: ${id}. Completion arrives as a notification; task(action: get, id: "${id}") re-reads it.`;
        return { ok: true, content: timeout.note === '' ? started : `${timeout.note}\n${started}` };
      }
      try {
        const result = await ctx.runShell(command, timeout.ms, kind);
        return { ok: result.exitCode === 0, content: shellBody(result, timeout.note) };
      } catch (error) {
        return { ok: false, content: errorMessage(error) };
      }
    },
  };
}

export const bashTool: ToolSpec = makeShellTool(
  'bash',
  'Run a POSIX shell command in the workspace root via bash (on Windows that means Git Bash: on PATH or beside the git executable).'
    + ' background: true returns a task id immediately; the result is pushed when the command exits.'
    + ' Each call is one-shot: no cwd, variable, or function survives between calls, so pass explicit paths'
    + ' instead of relying on an earlier cd. Check the exit-code marker on every result before moving on.'
    + ' A write denied by the workspace sandbox is policy, not a command bug: restate the path inside the'
    + ' workspace rather than reaching for another way to write it.',
);

export const pwshTool: ToolSpec = makeShellTool(
  'pwsh',
  'Run a PowerShell command in the workspace root via pwsh (Windows PowerShell if pwsh is missing).'
    + ' background: true returns a task id immediately; the result is pushed when the command exits.'
    + ' Each call is one-shot: no cwd, variable, or function survives between calls, so pass explicit paths'
    + ' instead of relying on an earlier cd. Check the exit-code marker on every result before moving on.'
    + ' Prefer npm.cmd / npx.cmd / node over bare npm / npx so PowerShell does not resolve .ps1 shims.'
    + ' A write denied by the workspace sandbox is policy, not a command bug: restate the path inside the'
    + ' workspace rather than reaching for another way to write it.',
);
