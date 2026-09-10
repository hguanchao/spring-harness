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
  return { command: found, prefixArgs: ['-NoProfile', '-NonInteractive', '-Command'] };
}
