/**
 * Windows 命令解析与 .cmd/.bat 启动。
 *
 * 为什么需要这个模块：`spawn('npx', ...)`（不带 shell）在 Windows 上走 CreateProcess，
 * 它在 PATH 里的查找只会自动补 `.exe`，**不认 `PATHEXT`**——而 npx / npm 在 Windows 上
 * 是批处理启动器（`npx.cmd`），根本没有 `npx.exe`。外部配置里
 * `command = "npx"` 是最常见的写法，不解析就等于 Windows 上这类 MCP server 必然 ENOENT。
 *
 * 解析到 `.cmd`/`.bat` 还不能直接 spawn：Node ≥18.20 / ≥20.12 出于 CVE-2024-27980 会拒绝
 * 无 shell 的批处理 spawn（EINVAL），必须经 `cmd.exe /d /s /c`。`/c` 内联串由 cmd 的解析器
 * 先于 argv 层处理，`()%!^"<>&|` 是它的元字符，所以参数要**双重转义**——先按
 * CommandLineToArgvW 规则翻倍反斜杠并包引号，再给 cmd 元字符（含刚加上的引号）前插 `^`。
 * 算法取自 cross-spawn（npm 生态用同一套规则实测多年），不自创。
 */

import { statSync, type Stats } from 'node:fs';
import { join } from 'node:path';

/** 批处理扩展名：CreateProcess 无法直接执行，必须经 cmd.exe。 */
const BATCH_EXTENSIONS = new Set(['.cmd', '.bat']);

/** PATHEXT 缺省值（Windows 出厂默认；环境里通常显式设置）。 */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';

export interface ResolvedCommand {
  file: string;
  /** true = 批处理启动器（.cmd/.bat），必须经 cmd.exe 启动。 */
  viaCmd: boolean;
}

function pathextList(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATHEXT ?? DEFAULT_PATHEXT;
  return raw
    .split(';')
    .map((ext) => ext.trim())
    .filter((ext) => ext !== '')
    .map((ext) => (ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`));
}

/** 取路径最后一段的扩展名（小写）；最后一段没有点返回空串。 */
function fileExtension(path: string): string {
  const lastSeparator = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  const dot = path.lastIndexOf('.');
  return dot > lastSeparator ? path.slice(dot).toLowerCase() : '';
}

function tryFile(path: string): ResolvedCommand | undefined {
  let stat: Stats;
  try {
    stat = statSync(path);
  } catch {
    return undefined;
  }
  if (!stat.isFile()) return undefined;
  return { file: path, viaCmd: BATCH_EXTENSIONS.has(fileExtension(path)) };
}

/**
 * 把命令解析成可执行文件。
 *
 * - 显式路径（含分隔符）：无扩展名时按 PATHEXT 逐个补试（CreateProcess 只会补 `.exe`，
 *   批处理和其它成员都得自己找）；已带扩展名就认文件本体。
 * - 裸名：逐目录 × PATHEXT 序扫描——**目录优先于扩展名**（cmd 的语义：扫完一个目录的全部
 *   候选再进下一个）。刻意的取舍：不搜当前目录（NoDefaultCurrentDirectoryInExePath 时代的
 *   安全默认，工作区里放一个 `evil.cmd` 不该被捡起来）。
 *
 * 找不到返回 undefined，调用方按原样 spawn——ENOENT 至少是诚实的结果。
 */
export function resolveWindowsCommand(command: string, env: NodeJS.ProcessEnv = process.env): ResolvedCommand | undefined {
  if (command.trim() === '') return undefined;
  const exts = pathextList(env);

  if (/[\\/]/.test(command)) {
    if (fileExtension(command) !== '') return tryFile(command);
    for (const ext of exts) {
      const resolved = tryFile(command + ext);
      if (resolved) return resolved;
    }
    return undefined;
  }

  // PATH 条目可能带引号（`"C:\some dir";...`），先剥掉。
  const rawPath = env.PATH ?? env.Path ?? '';
  const dirs = rawPath
    .split(';')
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter((dir) => dir !== '');
  for (const dir of dirs) {
    // 已带扩展名的裸名（npx.cmd / node.exe）先试原名，再补 PATHEXT。
    if (fileExtension(command) !== '') {
      const exact = tryFile(join(dir, command));
      if (exact) return exact;
    }
    for (const ext of exts) {
      const resolved = tryFile(join(dir, command + ext));
      if (resolved) return resolved;
    }
  }
  return undefined;
}

/**
 * cmd.exe /c 内联串的参数转义（cross-spawn 的 escapeArgument，doubleEscapeMetaChars=true）：
 * 1. CommandLineToArgvW 层——引号前的反斜杠翻倍、末尾反斜杠翻倍、包上双引号；
 * 2. cmd 元字符层——对 `() % ! ^ " < > & |`（含第 1 步加上的引号）前插 `^`。
 * cmd 的 /c 解析先剥 `^` 再组 argv，两层各归其位；顺序不能换。
 */
export function escapeCmdArgument(arg: string): string {
  let out = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  out = `"${out}"`;
  out = out.replace(/[()\]%!^"<>&|]/g, '^$&');
  return out;
}

/**
 * cmd.exe `/c` 的内联串：file + args 各自转义后拼起来。
 *
 * 必须配合 `spawn('cmd.exe', ['/d', '/s', '/c', line], { windowsVerbatimArguments: true })`
 * 使用（**数组**形态）。不能把整串塞进 command 传字符串：verbatim 下 Node 会把整串当
 * 待查找的**文件名**（实测 spawn ENOENT），而不是当 lpCommandLine。
 */
export function cmdArgumentLine(file: string, args: readonly string[]): string {
  return [file, ...args].map(escapeCmdArgument).join(' ');
}
