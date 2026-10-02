/**
 * 把文本写进系统剪贴板。
 *
 * 为什么不用 OSC 52 一条通路走完：OSC 52 是否被终端接受无法从进程侧确认，于是「Copied!」
 * 会在一台根本没写入剪贴板的终端（macOS Terminal.app、没开转发的 tmux）上照样亮——一个
 * 说谎的反馈比没有反馈更糟。这里优先走平台命令行工具，**按退出码判定成败**，只在工具
 * 全不可用时退回 OSC 52，并把那条通路如实标成尽力而为。
 *
 * 不引入第三方依赖：Windows 用系统自带的 powershell `Set-Clipboard`，macOS 用 `pbcopy`，
 * Linux 依次探测 `wl-copy` / `xclip` / `xsel`。全部用 spawn + 参数数组，绝不拼 shell 字符串，
 * 复制的文本里没有命令注入的入口。
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

/**
 * `native` = 工具退出码 0，剪贴板确实写进去了；
 * `osc52` = 只写给了终端，是否落进剪贴板无从确认；
 * `failed` = 两条都没有发生。
 */
export type CopyResult = 'native' | 'osc52' | 'failed';

type KoffiLib = { func(proto: string): (...args: unknown[]) => unknown };
type KoffiNs = { load(name: string): KoffiLib };

let ffiTried = false;
let ffiCopyFn: ((text: string) => boolean) | undefined;

/**
 * Windows 快通路：koffi 直接调 user32/kernel32 写 CF_UNICODETEXT，毫秒级。
 *
 * powershell `Set-Clipboard` 要冷启动整个 PowerShell，右键复制后「Copied!」慢一拍就是它。
 * FFI 通路的成败是真实的（SetClipboardData 返回 NULL 即失败），配得上 `native`。
 * 懒加载：第一次复制才碰 koffi/DLL；koffi 没装或加载失败返回 undefined，链路退回平台工具。
 */
function win32FfiCopy(): ((text: string) => boolean) | undefined {
  if (ffiTried) return ffiCopyFn;
  ffiTried = true;
  try {
    const require = createRequire(import.meta.url);
    const koffi = require('koffi') as KoffiNs;
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const open = user32.func('bool __stdcall OpenClipboard(void *hWndNewOwner)');
    const empty = user32.func('bool __stdcall EmptyClipboard()');
    const setData = user32.func('void *__stdcall SetClipboardData(unsigned int uFormat, void *hMem)');
    const close = user32.func('bool __stdcall CloseClipboard()');
    const alloc = kernel32.func('void *__stdcall GlobalAlloc(unsigned int uFlags, size_t dwBytes)');
    const lock = kernel32.func('void *__stdcall GlobalLock(void *hMem)');
    const unlock = kernel32.func('bool __stdcall GlobalUnlock(void *hMem)');
    const move = kernel32.func('void *__stdcall RtlMoveMemory(void *dst, void *src, size_t len)');
    const CF_UNICODETEXT = 13;
    const GMEM_MOVEABLE = 2;
    ffiCopyFn = (text: string): boolean => {
      // UTF-16LE + 终止 NUL：CF_UNICODETEXT 的约定格式。
      const bytes = Buffer.concat([Buffer.from(text, 'utf16le'), Buffer.from([0, 0])]);
      // 剪贴板可能被剪贴板管理器短暂持有：小退避重试几次再认输。
      let opened = false;
      for (let attempt = 0; attempt < 5 && !opened; attempt++) {
        opened = open(null) === true;
        if (!opened) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
      if (!opened) return false;
      try {
        if (empty() !== true) return false;
        const handle = alloc(GMEM_MOVEABLE, bytes.length);
        if (!handle) return false;
        const dst = lock(handle);
        if (!dst) return false;
        move(dst, bytes, bytes.length);
        unlock(handle);
        // 成功后句柄归剪贴板所有，调用方不得再释放。
        return setData(CF_UNICODETEXT, handle) !== null;
      } finally {
        close();
      }
    };
  } catch {
    ffiCopyFn = undefined;
  }
  return ffiCopyFn;
}

/** 跑一个外部命令并把 input 写进它的 stdin，返回退出码；起不来或超时返回 null。 */
export type RunTool = (command: string, args: readonly string[], input?: string) => Promise<number | null>;

/** Windows 上文本走 base64 进 -EncodedCommand：非 ASCII、引号、换行都到不了命令行解析。 */
export function windowsClipboardArgs(text: string): string[] {
  const payload = Buffer.from(text, 'utf8').toString('base64');
  const script =
    `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))` +
    ' | Set-Clipboard -ErrorAction Stop';
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

/** 各平台的候选通路，按顺序试到第一个退出码为 0 的为止。 */
export function clipboardTools(platform: NodeJS.Platform, text: string): Array<{ command: string; args: string[]; input?: string }> {
  if (platform === 'win32') return [{ command: 'powershell.exe', args: windowsClipboardArgs(text) }];
  if (platform === 'darwin') return [{ command: 'pbcopy', args: [], input: text }];
  return [
    { command: 'wl-copy', args: [], input: text },
    { command: 'xclip', args: ['-selection', 'clipboard'], input: text },
    { command: 'xsel', args: ['-ib'], input: text },
  ];
}

const RUN_TIMEOUT_MS = 5_000;

export const runTool: RunTool = (command, args, input) =>
  new Promise<number | null>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    // 命令不存在（ENOENT）在 error 事件里，退出码压根没有；超时靠 killSignal 结束。
    child.once('error', () => resolve(null));
    const timer = setTimeout(() => child.kill(), RUN_TIMEOUT_MS);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.stdin?.on('error', () => {
      // 工具不读 stdin 就提前退出时 EPIPE 会打到这个流上；退出码仍由 close 决定，别在这里当失败。
    });
    if (input === undefined) child.stdin?.end();
    else child.stdin?.end(input, 'utf8');
  });

/** OSC 52 序列：`copySelection` 缺位时由控件层自己写，这里供宿主复用同一条兜底。 */
export function osc52Sequence(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`;
}

/**
 * 依次试平台工具，全不可用再退回 OSC 52。
 *
 * `writeOsc52` 省略时不做兜底（返回 `failed`）：调用方若没有可写的终端，就不该报「已复制」。
 */
export async function copyToClipboard(
  text: string,
  options: {
    platform?: NodeJS.Platform;
    run?: RunTool;
    writeOsc52?: (sequence: string) => void;
  } = {},
): Promise<CopyResult> {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runTool;
  // Windows 优先走 FFI 快通路；没装 koffi 或拿不到剪贴板再落平台工具。
  if (platform === 'win32' && options.run === undefined && win32FfiCopy()?.(text) === true) return 'native';
  for (const tool of clipboardTools(platform, text)) {
    if ((await run(tool.command, tool.args, tool.input)) === 0) return 'native';
  }
  if (options.writeOsc52 === undefined) return 'failed';
  options.writeOsc52(osc52Sequence(text));
  return 'osc52';
}

/** 一条复制没成的补救说明：说清这台机器上「还能怎么办」，而不是只说失败。 */
export function clipboardFailureHint(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return 'Install PowerShell or use a terminal that accepts OSC 52 (Windows Terminal).';
  if (platform === 'darwin') return 'pbcopy is missing; use iTerm2 or another terminal that accepts OSC 52.';
  return 'Install wl-clipboard or xclip, or use a terminal that accepts OSC 52.';
}
