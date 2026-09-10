/**
 * TUI 输出原语：显示宽度、按宽度折行、截断补齐、ANSI 控制与着色。
 *
 * 为什么自研：本仓库运行时依赖只有 koffi + smol-toml，且界面文案与工具输出大量是中文，
 * 宽度算错会让整个底部区域错位（一行被终端折成两行，重绘时就向上吃掉一行）。
 * 这类宽度计算恰恰是现成库在 Latin 之外最容易出错的地方。
 *
 * 约定：文本先 sanitize 去掉控制字符，再量宽/折行；着色只加在已量宽的纯文本上，
 * 因此 displayWidth 必须能跳过转义序列（否则带色文本会被算宽）。
 */

/** [lo, hi] 闭区间表：零宽（组合字符、变体选择符、ZWJ 等）。 */
const ZERO_WIDTH: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x0610, 0x061a],
  [0x064b, 0x065f], [0x0670, 0x0670], [0x06d6, 0x06dc], [0x0e31, 0x0e31],
  [0x0e34, 0x0e3a], [0x0eb1, 0x0eb1], [0x0eb4, 0x0eb9], [0x0f71, 0x0f84],
  [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x200b, 0x200f], [0x2060, 0x2064],
  [0x20d0, 0x20f0], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0xfeff, 0xfeff],
  [0x1f3fb, 0x1f3ff], [0xe0100, 0xe01ef],
];

/** [lo, hi] 闭区间表：东亚宽字符（占 2 列）。 */
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x2e80, 0x2eff], [0x2f00, 0x2fdf], [0x2ff0, 0x2fff],
  [0x3000, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];

function inRanges(cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  for (const [lo, hi] of ranges) {
    if (cp < lo) return false;
    if (cp <= hi) return true;
  }
  return false;
}

/** 单个码点的显示列数：0（不可见/组合）、1 或 2（东亚宽）。 */
export function charWidth(cp: number): number {
  if (cp < 32) return 0;
  if (cp >= 0x7f && cp < 0xa0) return 0;
  if (cp >= 0xd800 && cp <= 0xdfff) return 0;
  if (inRanges(cp, ZERO_WIDTH)) return 0;
  return inRanges(cp, WIDE) ? 2 : 1;
}

/** 跳过从 start（指向 ESC）开始的一个转义序列，返回下一个未消费的下标。 */
function skipEscape(text: string, start: number): number {
  let i = start + 1;
  if (text[i] === '[') {
    i++;
    while (i < text.length && !/[@-~]/.test(text[i])) i++;
    return Math.min(i + 1, text.length);
  }
  return Math.min(i + 1, text.length);
}

/**
 * 文本的显示宽度（列）。非打印字符与零宽字符按 0 计，宽字符按 2 计。
 * 已量宽的纯文本与带色文本都能正确测量，因为转义序列会被跳过。
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    if (cp === 0x1b) {
      i = skipEscape(text, i);
      continue;
    }
    width += charWidth(cp);
    i += cp > 0xffff ? 2 : 1;
  }
  return width;
}

/** 去掉全部 ANSI 转义序列，得到纯文本。 */
export function stripAnsi(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; ) {
    if (text.codePointAt(i) === 0x1b) {
      i = skipEscape(text, i);
      continue;
    }
    out += text[i];
    i++;
  }
  return out;
}

/**
 * 净化不可打印字符：去掉 C0/C1 控制符与孤立代理项，tab 展开为空格，其余保留。
 * 保留 \n —— 折行依赖它分段。
 */
export function sanitize(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    if (cp === 0x0a) out += '\n';
    else if (cp === 0x09) out += '  ';
    // 整段转义序列一起丢掉：只丢 ESC 会留下 "[31m" 这类可见垃圾，反而污染屏幕。
    else if (cp === 0x1b) {
      i = skipEscape(text, i - ch.length);
      continue;
    }
    else if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue;
    else if (cp >= 0xd800 && cp <= 0xdfff) continue;
    else out += ch;
  }
  return out;
}

/**
 * 码点簇：零宽字符（变音符等）附着到前一个字符，硬切时不会把一个字符切开。
 *
 * 换行符**必须自成一簇**，不能按「零宽 → 黏到前一个字符」的规则并进去：多行输入靠
 * `parts[i] === '\n'` 找行边界，一旦 `\n` 被并成 `"a\n"` 这种簇，行边界就永远匹配不上
 * ——表现是编辑器里敲回车看不到换行，折行布局也算不对。
 */
export function clusters(text: string): Array<{ ch: string; width: number }> {
  const out: Array<{ ch: string; width: number }> = [];
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    // 转义序列零宽且必须整体保留：拆开会把着色指令截成可见文本。
    if (cp === 0x1b) {
      const end = skipEscape(text, i - ch.length);
      const escape = text.slice(i - ch.length, end);
      i = end;
      const last = out[out.length - 1];
      if (last) last.ch += escape;
      else out.push({ ch: escape, width: 0 });
      continue;
    }
    if (cp === 0x0a) {
      out.push({ ch, width: 0 });
      continue;
    }
    const width = charWidth(cp);
    const last = out[out.length - 1];
    if (width === 0 && last) {
      last.ch += ch;
      continue;
    }
    out.push({ ch, width });
  }
  return out;
}

/** 按显示宽度截断。被截断时以 marker 收尾（默认 `~`，纯 ASCII，宽度确定为 1）。 */
export function truncate(text: string, width: number, marker = '~'): string {
  const limit = Math.max(0, Math.floor(width));
  if (displayWidth(text) <= limit) return text;
  if (limit === 0) return '';
  const markerWidth = marker === '' ? 0 : displayWidth(marker);
  const room = Math.max(0, limit - markerWidth);
  let out = '';
  let used = 0;
  for (const cluster of clusters(text)) {
    if (used + cluster.width > room) break;
    out += cluster.ch;
    used += cluster.width;
  }
  // 若 marker 放不进剩余列，直接放弃 marker 而不是溢出。
  return used + markerWidth <= limit ? out + marker : out;
}

/**
 * 整帧绘制前的最后一道保险：把一行硬夹到宽度以内，不加截断标记。
 *
 * 为什么需要它：写满最后一列会触发终端的自动换行，让整帧**整体上移一行**——一行超宽
 * 就毁掉整屏。所以宁可截断也不能放过。截断带色文本会连带丢掉它末尾的复位序列，颜色会
 * 泄漏到之后的所有行上，因此只要这一行里出现过 SGR，就补一个复位收尾。
 */
export function clipLine(text: string, width: number): string {
  const limit = Math.max(0, Math.floor(width));
  if (limit === 0) return '';
  if (displayWidth(text) <= limit) return text;
  let out = '';
  let used = 0;
  for (const cluster of clusters(text)) {
    if (used + cluster.width > limit) break;
    out += cluster.ch;
    used += cluster.width;
  }
  return out === '' ? '' : out.includes('\x1b[') ? `${out}\x1b[0m` : out;
}

/** 右侧补空格到指定宽度；超宽则先截断。 */
export function pad(text: string, width: number): string {
  const limit = Math.max(0, Math.floor(width));
  const fitted = truncate(text, limit, '');
  const gap = limit - displayWidth(fitted);
  return gap > 0 ? fitted + ' '.repeat(gap) : fitted;
}

/**
 * 按显示宽度折行：优先在空格处断开，无空格的长串（CJK 段落、长路径）硬切。
 * 返回值中每行宽度都 <= width，调用方可以据此断定「一行 = 一屏一行」。
 */
export function wrap(text: string, width: number): string[] {
  const limit = Math.max(1, Math.floor(width));
  const out: string[] = [];
  for (const paragraph of sanitize(text).split('\n')) {
    if (paragraph === '') {
      out.push('');
      continue;
    }
    let line = '';
    let lineWidth = 0;
    for (const token of paragraph.match(/ +|[^ ]+/g) ?? []) {
      // 行首空格直接丢弃：否则窄宽度下会白白推出一串空行。
      if (line === '' && token.startsWith(' ')) continue;
      const tokenWidth = displayWidth(token);
      if (tokenWidth > limit) {
        if (line !== '') {
          out.push(line.replace(/\s+$/, ''));
          line = '';
          lineWidth = 0;
        }
        const pieces = hardSplit(token, limit);
        for (let i = 0; i < pieces.length - 1; i++) out.push(pieces[i]);
        line = pieces[pieces.length - 1] ?? '';
        lineWidth = displayWidth(line);
        continue;
      }
      if (lineWidth + tokenWidth > limit) {
        out.push(line.replace(/\s+$/, ''));
        line = token.trimStart();
        lineWidth = displayWidth(line);
        continue;
      }
      if (line === '' && token.startsWith(' ')) continue;
      line += token;
      lineWidth += tokenWidth;
    }
    out.push(line.replace(/\s+$/, ''));
  }
  return out;
}

function hardSplit(token: string, limit: number): string[] {
  const out: string[] = [];
  let current = '';
  let currentWidth = 0;
  for (const cluster of clusters(token)) {
    if (currentWidth + cluster.width > limit) {
      out.push(current);
      current = '';
      currentWidth = 0;
    }
    current += cluster.ch;
    currentWidth += cluster.width;
  }
  if (current !== '') out.push(current);
  return out;
}

export interface Styler {
  readonly enabled: boolean;
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
  magenta(text: string): string;
  /** 反显：终端里最标准的「选中」表达，不依赖色相，16 色下也醒目。 */
  inverse(text: string): string;
  /** 搜索命中：加粗黄，比单独一个色相更容易在一行里被看见。 */
  highlight(text: string): string;
  /** 斜体。部分终端没有斜体字形会退化成常规体，因此不能作为唯一的信息载体。 */
  italic(text: string): string;
  /** 下划线。用于链接正文。 */
  underline(text: string): string;
  /** 删除线。 */
  strike(text: string): string;
  /**
   * 指定背景色。**必须自己补齐到整行宽度**：SGR 的背景只覆盖实际打印出的字符，
   * 不覆盖行尾空白，短行会露出一截没上色的缝隙。
   * @param reset 收尾序列——上层可能叠了别的属性（如选中态反显），复位时要一并还原。
   */
  bg(text: string, code: number, reset?: string): string;
  /**
   * 真彩背景。`#2e2e2e` 这类指定色值必须走 24 位 SGR，但真彩不是到处都有，
   * 因此按终端能力降级：真彩 → 256 色 → 16 色。调用方只给色值，不关心落到哪一级。
   */
  bgRgb(text: string, r: number, g: number, b: number, reset?: string): string;
}

/**
 * 对话框背景：亮黑（`100`）在浅色终端里就是一层浅灰，在深色终端里也只是一条低调的
 * 深灰衬底，两种主题下都不刺眼。刻意不用 `47`（白底）——那种「白得发亮」的块在
 * Windows Terminal 浅色主题下比正文还抢眼。
 *
 * 它落在 16 色亮色段：少数终端主题里亮黑偏冷或偏紫，因此只作为「区域衬底」，
 * 不承载任何语义——无色终端下直接退化为无背景，正文依然可读。
 */
export const DIALOG_BG = 100;

/** 反显收尾：先关反显（27），再恢复对话框背景（49）。顺序反了会把背景一起抹掉。 */
export const INVERSE_BUBBLE_RESET = '\x1b[27m\x1b[49m';

/**
 * 色彩深度：3 = 真彩（24 位），2 = 256 色，1 = 16 色。
 *
 * 只影响「指定色值」这一类需求（比如 `#2e2e2e`），语义色（红/绿/黄/青）一律走 16 色，
 * 所以低深度终端下界面依然完整，只是衬底灰度差几级。
 */
export type ColorDepth = 1 | 2 | 3;

/**
 * 探测终端色彩深度。
 *
 * 只认两个信号：`COLORTERM` 含 `truecolor`/`24bit`，或 `TERM` 含 `256color`。
 * 两者都没有就按 16 色处理 —— **宁可低估也不要高估**：高估会发出终端不认识的 SGR，
 * 结果不是「颜色差点」而是「整块背景色丢失」或更糟的乱码。
 */
export function colorDepth(env: NodeJS.ProcessEnv = process.env): ColorDepth {
  const colorTerm = (env.COLORTERM ?? '').toLowerCase();
  if (colorTerm.includes('truecolor') || colorTerm.includes('24bit')) return 3;
  if (/\b256(?:color)?\b/.test(env.TERM ?? '')) return 2;
  return 1;
}

/**
 * 取某行在 `[startCol, endCol)` 显示列区间内的**可见文本**（去掉所有着色）。
 *
 * 必须按簇走而不是按字符下标切：CJK 一个字占两列、组合字符零宽，`slice` 会切在半个字上。
 */
export function visibleSlice(text: string, startCol: number, endCol: number): string {
  if (endCol <= startCol) return '';
  let out = '';
  let col = 0;
  for (const cluster of clusters(text)) {
    if (cluster.width === 0) continue; // 转义序列与零宽字符不占列
    if (col >= endCol) break;
    if (col >= startCol) out += stripAnsi(cluster.ch);
    col += cluster.width;
  }
  return out;
}

/**
 * 把某行的 `[startCol, endCol)` 列区间置为**反显**（选区高亮）。
 *
 * 难点是区间内部本身就带着色：一段 `\x1b[36m…\x1b[0m` 里的完整复位会顺手把反显一起
 * 关掉，只在高亮开头插一次 `\x1b[7m` 的话，高亮到第一个 `\x1b[0m` 就断了。
 * 因此区间内每个复位之后都要**重新开一次反显**——`\x1b[0m` → `\x1b[0m\x1b[7m`。
 *
 * 只在簇边界切开，转义序列永远不会被截成可见文本。
 */
export function inverseRange(text: string, startCol: number, endCol: number): string {
  if (endCol <= startCol) return text;
  let out = '';
  let col = 0;
  let armed = false;
  for (const cluster of clusters(text)) {
    // 零宽的簇（行首转义、组合字符）不占列，不能成为选区的起点。
    const selected = cluster.width > 0 && col >= startCol && col < endCol;
    if (selected && !armed) {
      out += '\x1b[7m';
      armed = true;
    } else if (!selected && armed) {
      out += '\x1b[27m';
      armed = false;
    }
    out += selected ? cluster.ch.replace(/\x1b\[0m/g, '\x1b[0m\x1b[7m') : cluster.ch;
    col += cluster.width;
  }
  return armed ? `${out}\x1b[27m` : out;
}

/** 24 位色 → 256 色灰度档（232..255 是灰阶，232=#080808，每档 +10）。 */
function grayIndex(r: number, g: number, b: number): number {
  const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  return Math.min(255, Math.max(232, 232 + Math.round((gray - 8) / 10)));
}

/** 着色器：关闭时所有方法退化为恒等函数，调用方无需到处判断是否支持彩色。 */
export function createStyler(enabled: boolean, depth: ColorDepth = 1): Styler {
  const code = (sgr: string) => (text: string) => (enabled ? `\x1b[${sgr}m${text}\x1b[0m` : text);
  return {
    enabled,
    bold: code('1'),
    dim: code('2'),
    red: code('31'),
    green: code('32'),
    yellow: code('33'),
    cyan: code('36'),
    magenta: code('35'),
    inverse: code('7'),
    // 组合 SGR 而不是嵌套调用：嵌套会让内层的 reset 提前终止外层样式。
    highlight: code('1;33'),
    italic: code('3'),
    underline: code('4'),
    strike: code('9'),
    bg: (text, bgCode, reset = '\x1b[0m') => (enabled ? `\x1b[${bgCode}m${text}${reset}` : text),
    bgRgb: (text, r, g, b, reset = '\x1b[0m') => {
      if (!enabled) return text;
      const open = depth >= 3 ? `\x1b[48;2;${r};${g};${b}m` : depth === 2 ? `\x1b[48;5;${grayIndex(r, g, b)}m` : `\x1b[${DIALOG_BG}m`;
      return `${open}${text}${reset}`;
    },
  };
}

/** 终端是否适合彩色输出：非 TTY、NO_COLOR、TERM=dumb 一律降级为纯文本。 */
export function colorEnabled(env: NodeJS.ProcessEnv = process.env, isTty = process.stdout.isTTY): boolean {
  if (!isTty) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.TERM === 'dumb') return false;
  return true;
}

export const ansi = {
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  /** 清整行（含行尾）。整帧重绘时逐行调用，上一帧更长的一行不会留下残尾。 */
  clearLine: '\x1b[2K',
  /** 光标移回左上角，作为整帧重绘的起点。 */
  home: '\x1b[H',
  /** 光标移到绝对位置（0-based 行列）。 */
  position: (row: number, col: number): string =>
    `\x1b[${Math.max(1, row + 1)};${Math.max(1, col + 1)}H`,
  /** 换行并回到行首。raw mode 关掉了 OPOST，`\n` 不再带回车，必须显式带上 `\r`。 */
  newline: '\r\n',
  /**
   * 进入替代屏幕缓冲区：得到一个全新的空白屏幕，退出时终端自动还原进入前的画面。
   * 这是「独立界面」的实现方式，也是 vim / htop 一类全屏程序的标准做法。
   */
  altScreenOn: '\x1b[?1049h\x1b[2J\x1b[H',
  altScreenOff: '\x1b[?1049l',
  /**
   * 同步输出（DECSET/DECRST 2026）：让终端把一帧当作一个整体提交，避免整帧重绘时
   * 出现「上半屏是旧帧、下半屏是新帧」的撕裂或闪烁。不支持的终端会忽略这两个序列，
   * 因此无条件发送是安全的。
   */
  syncOn: '\x1b[?2026h',
  syncOff: '\x1b[?2026l',
  bracketedPasteOn: '\x1b[?2004h',
  bracketedPasteOff: '\x1b[?2004l',
  /**
   * 鼠标跟踪。只开三样，别的都不开：
   * - `?1000h` 按键事件跟踪——够收到滚轮（滚轮就是一个「按键」），且不发鼠标移动；
   * - `?1006h` SGR 扩展坐标——坐标用文本 `\x1b[<b;x;yM` 给出，不像老的 X10 格式那样
   *   塞原始字节（那些字节会落进输入行变成乱码），且坐标不受 223 列上限约束；
   * - `?1002h` **按住拖动**时的移动事件——应用内拖选靠它拿到连续的终点坐标。
   *
   * 刻意**不开** `?1003h`（任意移动）：那会让每次鼠标划过都变成一条待解析的序列，
   * 而本项目只在「按住左键」期间需要坐标。
   *
   * 代价：终端不再自己处理鼠标拖选，Windows Terminal 下要按住 Shift 才是原生选择。
   * 因此拖选由我们自己实现（按下 → 拖动 → 松开即复制），见 app 的 handleMouseKey。
   */
  mouseOn: '\x1b[?1000h\x1b[?1002h\x1b[?1006h',
  mouseOff: '\x1b[?1006l\x1b[?1002l\x1b[?1000l',
};
