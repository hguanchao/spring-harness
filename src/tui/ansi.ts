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

/** 码点簇：零宽字符（变音符等）附着到前一个字符，硬切时不会把一个字符切开。 */
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
}

/** 着色器：关闭时所有方法退化为恒等函数，调用方无需到处判断是否支持彩色。 */
export function createStyler(enabled: boolean): Styler {
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
  clearLine: '\x1b[2K',
  eraseToEnd: '\x1b[J',
  /** 光标移到本行第 col 列（0-based）。 */
  column: (col: number): string => `\x1b[${Math.max(1, col + 1)}G`,
  /** 光标上移 n 行（n<=0 时为空串，便于无条件拼接）。 */
  up: (rows: number): string => (rows > 0 ? `\x1b[${rows}A` : ''),
  bracketedPasteOn: '\x1b[?2004h',
  bracketedPasteOff: '\x1b[?2004l',
};
