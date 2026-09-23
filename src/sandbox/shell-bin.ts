import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

function lookOnPath(name: string, accept: (file: string) => boolean = () => true): string | undefined {
  const path = process.env.PATH ?? '';
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = join(dir, `${name}${ext}`);
      if (existsSync(file) && accept(file)) return file;
    }
  }
  return undefined;
}

/**
 * Windows 自带的 System32\bash.exe 是 WSL 启动器，不是 bash：没装发行版时只打印一句
 * 错误并以 1 退出（输出还会被码页糟蹋成 `?????`），装了则把命令丢进发行版里跑——路径与
 * git 都是另一套。两种都不是调用方要的 Git Bash，必须排除。
 */
function isWslLauncher(file: string): boolean {
  const root = process.env.SystemRoot ?? process.env.windir;
  if (!root) return false;
  const normalize = (value: string): string => value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const target = normalize(file);
  return target.startsWith(`${normalize(root)}\\`) && target.endsWith('\\bash.exe');
}

/**
 * 从一份 git.exe 向上找同装的 Git Bash。
 *
 * 安装器只把 `<root>\cmd` 放进 PATH，bash 在 `<root>\bin` 或 `<root>\usr\bin`。
 */
function bashBeside(git: string): string | undefined {
  let dir = dirname(git);
  for (let depth = 0; depth < 3; depth += 1) {
    for (const candidate of [join(dir, 'bin', 'bash.exe'), join(dir, 'usr', 'bin', 'bash.exe')]) {
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * 沿 PATH 找带 Git Bash 的那一份 git。
 *
 * 不能停在第一份：工具链会把自己的最小 git 插到 PATH 最前，那份只有 git.exe、没有 bash。
 * 后面才是 Git for Windows。停在第一份会让 bash 工具误报「没装 Git Bash」。
 */
function bashBesideGit(): string | undefined {
  const path = process.env.PATH ?? '';
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const git = join(dir, `git${ext}`);
      if (!existsSync(git)) continue;
      const bash = bashBeside(git);
      if (bash) return bash;
    }
  }
  return undefined;
}

export type ShellKind = 'bash' | 'pwsh';

export function resolveBashBinary(): { command: string; prefixArgs: string[] } {
  let wslLauncher: string | undefined;
  const onPath = lookOnPath('bash', (file) => {
    if (process.platform !== 'win32' || !isWslLauncher(file)) return true;
    wslLauncher = file;
    return false;
  });
  if (onPath) return { command: onPath, prefixArgs: ['-c'] };
  if (process.platform === 'win32') {
    const besideGit = bashBesideGit();
    if (besideGit) return { command: besideGit, prefixArgs: ['-c'] };
    throw new Error(wslLauncher
      ? `bash on PATH is only the WSL launcher (${wslLauncher}), not Git Bash — install Git for Windows, or use the pwsh tool instead`
      : 'Git Bash not found — install Git for Windows (or add its bin directory to PATH), or use the pwsh tool instead');
  }
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

/** 一次性命令的 argv：shell 二进制 + 前缀 + 脚本。loop 与 shell 工具共用，避免两处各拼一遍。 */
export function shellArgv(script: string, kind: ShellKind = process.platform === 'win32' ? 'pwsh' : 'bash'): {
  command: string;
  args: string[];
} {
  const shell = kind === 'pwsh' ? resolvePwshBinary() : resolveBashBinary();
  return { command: shell.command, args: [...shell.prefixArgs, script] };
}
