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

/** CreateProcessAsUserW 需要绝对路径；PATH 搜索只发生在 CreateProcessW。 */
export function resolveShellBinary(): { command: string; prefixArgs: string[] } {
  if (process.platform !== 'win32') {
    return { command: '/bin/sh', prefixArgs: ['-c'] };
  }
  const found = lookOnPath('pwsh') ?? lookOnPath('powershell');
  if (!found) throw new Error('pwsh/powershell not found on PATH');
  // Bypass：机器 ExecutionPolicy 常拦 npm.ps1 / npx.ps1，那是宿主策略，不是命令写错。
  return {
    command: found,
    prefixArgs: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'],
  };
}

/** 一次性命令的 argv：shell 二进制 + 前缀 + 脚本。loop 与 shell 工具共用，避免两处各拼一遍。 */
export function shellArgv(script: string): { command: string; args: string[] } {
  const shell = resolveShellBinary();
  return { command: shell.command, args: [...shell.prefixArgs, script] };
}
