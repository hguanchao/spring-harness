/**
 * 剪贴板写入。
 *
 * 两条路都要走，因为它们失败的场景完全不同：
 *
 * 1. **OSC 52** —— 不发子进程、不依赖外部命令，但**终端必须支持**。Windows Terminal、
 *    iTerm2、kitty 支持，老 conhost 与部分 Linux 终端不支持（静默丢弃）。
 * 2. **原生命令** —— 一定准，但要起子进程，且命令名因平台而异。
 *
 * 因此先发 OSC 52（快且无副作用），再补一次原生命令兜底；两条都写同样内容，
 * 重复一次没有代价，漏掉一次则用户什么都没复制到。
 *
 * 参考 opencode 的做法（`packages/tui/src/clipboard.ts`）：它也是 OSC 52 优先、
 * 原生命令回退（`osascript` / `wl-copy` / `xclip` / `Set-Clipboard` / `clipboardy`）。
 */
import { spawn } from 'node:child_process';

/** OSC 52 报文：内容必须是 base64，否则中间的转义字节会污染终端状态。 */
export function osc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`;
}

/** 各平台的复制命令；没有可用命令返回 undefined（此时只能指望 OSC 52）。 */
export function copyCommand(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] | undefined {
  if (platform === 'darwin') return ['pbcopy'];
  /**
   * Windows **不能用 `clip.exe`**：它按控制台当前代码页解释 stdin，而 Node 送进去的是
   * UTF-8。中文 Windows 上代码页是 936(GBK)，两套编码错位就成了乱码；更隐蔽的是它
   * **逐块解码**，跨读取块边界的汉字会被劈开成替换字符 —— 表现为「短文本对、中英混排或
   * 长文本时随机崩一个字」，极难复现。实测三种喂法（UTF-8 / UTF-8+BOM / UTF-16LE+BOM）
   * 全部失败，说明不是「换个编码就好」，而是这个工具本身不可用。
   *
   * 改用 PowerShell 的 `Set-Clipboard`，关键是**显式把 stdin 编码钉死为 UTF-8**，
   * 消除「按代码页猜」这段不确定性；`Set-Clipboard` 直接写 Win32 剪贴板的
   * UnicodeText 格式，不经过 OEM 代码页转换。opencode 也是这么做的。
   * 代价是 PowerShell 启动慢 200-400ms —— 复制是用户主动操作、不是热路径，可以接受。
   */
  if (platform === 'win32') {
    return [
      'powershell.exe',
      '-NonInteractive',
      '-NoProfile',
      '-Command',
      '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())',
    ];
  }
  if (platform === 'linux') {
    if (env.WAYLAND_DISPLAY !== undefined && env.WAYLAND_DISPLAY !== '') return ['wl-copy'];
    return ['xclip', '-selection', 'clipboard'];
  }
  return undefined;
}

/** 起子进程写剪贴板。参数走数组、不开 shell，因此不存在命令注入面。 */
function runCopy(command: readonly string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'ignore', 'ignore'] });
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    child.on('error', () => done(false));
    child.on('close', (code) => done(code === 0));
    child.stdin?.on('error', () => done(false));
    child.stdin?.end(text);
  });
}

/**
 * 剪贴板写入方式。`SPH_CLIPBOARD` 可覆盖：
 *
 * - `both`（默认）—— OSC 52 + 原生命令，两者互补；
 * - `osc52` —— 只发 OSC 52，不起子进程（测试与「不想被弹子进程」的场景用）；
 * - `off` —— 完全不写（终端不支持且不想起子进程时用）。
 */
export type ClipboardMode = 'both' | 'osc52' | 'off';

/** 写入结果，见 `writeClipboard` 的说明。 */
export type ClipboardResult = 'native' | 'osc52' | 'none';

export function clipboardMode(env: NodeJS.ProcessEnv = process.env): ClipboardMode {
  const value = (env.SPH_CLIPBOARD ?? '').trim().toLowerCase();
  if (value === 'off' || value === '0' || value === 'false') return 'off';
  if (value === 'osc52') return 'osc52';
  return 'both';
}

/**
 * 写入剪贴板。
 *
 * 返回值是**「能不能相信剪贴板里现在是正确内容」**，不是「有没有尝试过」：
 *
 * - `'native'` —— 原生命令退出码 0，内容确实写进去了（最可信）；
 * - `'osc52'`  —— 只能靠 OSC 52，已经发出报文，但**终端是否支持我们收不到反馈**
 *                  （只写通道），所以「大概率成功」而不是「确定成功」；
 * - `'none'`   —— 两条路都没成功，剪贴板很可能还是旧内容。
 *
 * 这个区分很重要：以前把「OSC 52 报文写进 stdout 没抛异常」当成成功，于是
 * `clip.exe` 明明写错了内容，界面照样提示「已复制到剪贴板」—— 用户以为成功、
 * 粘贴出来却是乱码。调用方据此给出诚实的提示。
 *
 * 非 TTY 时 OSC 52 无意义（没人接收），只走原生命令。
 */
export async function writeClipboard(
  text: string,
  isTty: boolean = process.stdout.isTTY,
  mode: ClipboardMode = clipboardMode(),
): Promise<ClipboardResult> {
  if (text === '' || mode === 'off') return 'none';

  const command = mode === 'osc52' ? undefined : copyCommand();
  // 原生命令优先：它是唯一能拿到确定结果的路径。先跑它，成功就不用管 OSC 52 了。
  if (command) {
    if (await runCopy(command, text)) return 'native';
  }

  // 主路径失败（或本来就没有命令）才发 OSC 52 兜底。
  if (!isTty) return 'none';
  try {
    // tmux / screen 会吞掉 OSC 52，必须用 DCS passthrough 包一层，否则外层收不到。
    const sequence = osc52(text);
    const wrapped = `\x1bPtmux;\x1b${sequence}\x1b\\`;
    const insideTmux = process.env.TMUX !== undefined && process.env.TMUX !== '';
    process.stdout.write(insideTmux ? wrapped : sequence);
    return 'osc52';
  } catch {
    return 'none';
  }
}
