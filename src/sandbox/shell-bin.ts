import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

function lookOnPath(name: string): string | undefined {
  const path = process.env.PATH ?? '';
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = join(dir, `${name}${ext}`);
      if (existsSync(file)) return file;
    }
  }
  return undefined;
}

export type ShellKind = 'bash' | 'pwsh';

export function resolveBashBinary(): { command: string; prefixArgs: string[] } {
  if (process.platform === 'win32') {
    const found = lookOnPath('bash');
    if (!found) throw new Error('bash not found on PATH');
    return { command: found, prefixArgs: ['-c'] };
  }
  const found = lookOnPath('bash');
  if (found) return { command: found, prefixArgs: ['-c'] };
  if (existsSync('/bin/bash')) return { command: '/bin/bash', prefixArgs: ['-c'] };
  if (existsSync('/bin/sh')) return { command: '/bin/sh', prefixArgs: ['-c'] };
  throw new Error('bash not found on PATH');
}

export function resolvePwshBinary(): { command: string; prefixArgs: string[] } {
  const found = lookOnPath('pwsh') ?? (process.platform === 'win32' ? lookOnPath('powershell') : undefined);
  if (!found) throw new Error('pwsh not found on PATH');
  const prefixArgs = process.platform === 'win32'
    ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']
    : ['-NoProfile', '-NonInteractive', '-Command'];
  return { command: found, prefixArgs };
}

/** CreateProcessAsUserW 需要绝对路径；PATH 搜索只发生在 CreateProcessW。 */
export function resolveShellBinary(): { command: string; prefixArgs: string[] } {
  return resolvePwshBinary();
}

/** 一次性命令的 argv：shell 二进制 + 前缀 + 脚本。loop 与 shell 工具共用，避免两处各拼一遍。 */
export function shellArgv(script: string, kind: ShellKind = process.platform === 'win32' ? 'pwsh' : 'bash'): {
  command: string;
  args: string[];
} {
  const shell = kind === 'pwsh' ? resolvePwshBinary() : resolveBashBinary();
  return { command: shell.command, args: [...shell.prefixArgs, script] };
}
