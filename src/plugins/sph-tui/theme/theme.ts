/**
 * 主题：命名色板编译成 ANSI，组件只按名字取色。
 * 默认色板在 palettes.ts；`~/.sph/theme.json` 可覆盖同名 hex。
 */

import { existsSync, readFileSync } from 'node:fs';
import type { EditorTheme, MarkdownTheme, SelectListTheme, SelectionHighlight } from '../../../tui/index.js';
import { overlayPalette, PALETTE, type ThemeColor } from './palettes.js';

export type { ThemeColor };
/**
 * 'ansi' = 终端默认配色：只发基础 ANSI 码（31–37/90–97 + 39/49），实际颜色由
 * 终端主题决定——sph 不再跟用户的终端配色打架。SPH_THEME=terminal 显式选用。
 */
export type ColorMode = 'truecolor' | '256color' | 'ansi';

const colorEnabled = detectColorEnabled();

function detectColorEnabled(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  if (process.env.FORCE_COLOR === '0') return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '') return true;
  return process.stdout.isTTY === true;
}

function sgr(open: string, close: string, text: string): string {
  if (!colorEnabled) return text;
  return `${open}${text}${close}`;
}

function detectColorMode(): ColorMode {
  // 显式优先：SPH_THEME=terminal 表示「跟随终端主题」，不再自己上色。
  if ((process.env.SPH_THEME ?? '').toLowerCase() === 'terminal') return 'ansi';
  const colorterm = (process.env.COLORTERM ?? '').toLowerCase();
  if (colorterm.includes('truecolor') || colorterm.includes('24bit')) return 'truecolor';
  const term = (process.env.TERM ?? '').toLowerCase();
  if (term.includes('direct')) return 'truecolor';
  return '256color';
}

function shimmerWeight(delta: number, band: number): number {
  const dist = Math.abs(delta);
  if (dist >= band) return 0;
  const t = 1 - dist / band;
  return t * t;
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  return `#${clamp(r)}${clamp(g)}${clamp(b)}`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const cleaned = hex.replace('#', '');
  if (cleaned.length !== 6) throw new Error(`Invalid hex color: ${hex}`);
  const r = Number.parseInt(cleaned.substring(0, 2), 16);
  const g = Number.parseInt(cleaned.substring(2, 4), 16);
  const b = Number.parseInt(cleaned.substring(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) throw new Error(`Invalid hex color: ${hex}`);
  return { r, g, b };
}

const CUBE_VALUES = [0, 95, 135, 175, 215, 255];
const GRAY_VALUES = Array.from({ length: 24 }, (_, i) => 8 + i * 10);

function findClosestCubeIndex(value: number): number {
  let minDist = Number.POSITIVE_INFINITY;
  let minIdx = 0;
  for (let i = 0; i < CUBE_VALUES.length; i++) {
    const dist = Math.abs(value - CUBE_VALUES[i]);
    if (dist < minDist) {
      minDist = dist;
      minIdx = i;
    }
  }
  return minIdx;
}

function findClosestGrayIndex(gray: number): number {
  let minDist = Number.POSITIVE_INFINITY;
  let minIdx = 0;
  for (let i = 0; i < GRAY_VALUES.length; i++) {
    const dist = Math.abs(gray - GRAY_VALUES[i]);
    if (dist < minDist) {
      minDist = dist;
      minIdx = i;
    }
  }
  return minIdx;
}

function colorDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
}

function rgbTo256(r: number, g: number, b: number): number {
  const rIdx = findClosestCubeIndex(r);
  const gIdx = findClosestCubeIndex(g);
  const bIdx = findClosestCubeIndex(b);
  const cubeR = CUBE_VALUES[rIdx];
  const cubeG = CUBE_VALUES[gIdx];
  const cubeB = CUBE_VALUES[bIdx];
  const cubeIndex = 16 + 36 * rIdx + 6 * gIdx + bIdx;
  const cubeDist = colorDistance(r, g, b, cubeR, cubeG, cubeB);

  const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  const grayIdx = findClosestGrayIndex(gray);
  const grayValue = GRAY_VALUES[grayIdx];
  const grayIndex = 232 + grayIdx;
  const grayDist = colorDistance(r, g, b, grayValue, grayValue, grayValue);

  // 色立方在暗部只有 0x00 / 0x5f 两档，深色背景（如 #343541）落到立方上会被拉成 #5f5f5f
  // 这类刺眼的亮灰。这里不做「是否够中性」的预判，直接按加权距离在色立方与灰阶之间择优：
  // 带明显色相的颜色灰阶误差远大于立方误差，仍会走立方分支。
  return grayDist < cubeDist ? grayIndex : cubeIndex;
}

function hexTo256(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return rgbTo256(r, g, b);
}

/**
 * ansi 模式的语义色 → 基础 SGR 码表。颜色完全由终端主题的 16 色调色板决定：
 * primary/标题/列表/进行中 = 亮品红（95），正文 = 终端默认前景（39），
 * 弱化系 = 亮黑（90），行内码 = 亮蓝（94），状态三色 = 92/91/93。
 * 未映射的键（如已废弃的 syntax*）回落默认前景，不会抛错。
 */
const ANSI_FG: Record<string, string> = {
  primary: '95', accent: '95', thinkingText: '95', selectedMark: '95',
  mdHeading: '95', mdH1: '95', mdH2: '95', mdH3: '95', mdH4: '95', mdH5: '95', mdH6: '95',
  mdListBullet: '95',
  text: '39', mdText: '39', userMessageText: '39',
  muted: '90', dim: '90', border: '90', borderMuted: '90',
  toolTitle: '90', toolOutput: '90', mdCodeBlock: '90', mdCodeBlockBorder: '90',
  mdQuote: '90', mdQuoteBorder: '90', mdHr: '90', mdLinkUrl: '90', scrollbarTrack: '90',
  scrollbarThumb: '90',
  mdLink: '97', mdCode: '94', plan: '94',
  success: '92', error: '91', warning: '93',
};

/**
 * ansi 模式的背景码：画布交还终端默认底（49）——「跟随终端」的核心；面层用亮黑（100）。
 * 划词高亮这里不给码：ansi 模式退回反显，块底由终端的 16 色主题决定（见 Theme.selectionStyle）。
 */
const ANSI_BG: Record<string, string> = {
  bg: '49',
  userMessageBg: '100', toolPendingBg: '100',
  // 挂起条悬停底用 256 色深灰：16 色档位里没有「只亮一档」的中间带。
  steerHoverBg: '48;5;236',
};

function fgAnsi(color: string, mode: ColorMode): string {
  if (mode === 'truecolor') {
    const { r, g, b } = hexToRgb(color);
    return `\x1b[38;2;${r};${g};${b}m`;
  }
  return `\x1b[38;5;${hexTo256(color)}m`;
}

function bgAnsi(color: string, mode: ColorMode): string {
  if (mode === 'truecolor') {
    const { r, g, b } = hexToRgb(color);
    return `\x1b[48;2;${r};${g};${b}m`;
  }
  return `\x1b[48;5;${hexTo256(color)}m`;
}

export class Theme {
  private readonly fgColors = new Map<string, string>();
  private readonly bgColors = new Map<string, string>();
  private palette: Record<string, string> = PALETTE;
  private mode: ColorMode = detectColorMode();

  constructor(palette: Record<string, string>, mode: ColorMode = detectColorMode()) {
    this.recompile(palette, mode);
  }

  /** 读完 ~/.sph/theme.json 后重编译，不必重建单例。 */
  recompile(palette: Record<string, string>, mode: ColorMode = detectColorMode()): void {
    this.palette = palette;
    this.mode = mode;
    this.fgColors.clear();
    this.bgColors.clear();
    if (mode === 'ansi') {
      // 与 truecolor 分支同语义：无条件预编译（NO_COLOR 的历史缺口两者共有，不在此处单边修）。
      for (const key of Object.keys(palette)) {
        this.fgColors.set(key, `\x1b[${ANSI_FG[key] ?? '39'}m`);
        this.bgColors.set(key, `\x1b[${ANSI_BG[key] ?? '49'}m`);
      }
      return;
    }
    for (const [key, value] of Object.entries(palette)) {
      this.fgColors.set(key, fgAnsi(value, mode));
      this.bgColors.set(key, bgAnsi(value, mode));
    }
  }

  fg(color: ThemeColor, text: string): string {
    return `${this.fgSeq(color)}${text}\x1b[39m`;
  }

  /** 裸前景 SGR。只在需要自己管复位的地方用（如划词高亮块），包文字请用 fg()。 */
  fgSeq(color: ThemeColor): string {
    const ansi = this.fgColors.get(color);
    if (!ansi) throw new Error(`Unknown theme color: ${color}`);
    return ansi;
  }

  /**
   * 从左到右扫一道高光。暗底灰字上有一束更亮的带，周期跟状态行转圈同一量级。
   * 无色终端原样返回。
   */
  shimmer(text: string, nowMs: number, dim: ThemeColor = 'muted', bright: ThemeColor = 'text'): string {
    if (text === '' || !colorEnabled) return text;
    const chars = [...text];
    const n = chars.length;
    const band = 3.5;
    const period = n + band + 8;
    const head = ((nowMs / 90) % period) - band;
    const dimHex = this.palette[dim];
    const brightHex = this.palette[bright];
    if (dimHex === undefined || brightHex === undefined) return this.fg(dim, text);
    if (this.mode === 'ansi') {
      let out = '';
      for (let i = 0; i < n; i++) {
        const t = shimmerWeight(i - head, band);
        out += t > 0.45 ? this.fg(bright, chars[i]!) : this.fg(dim, chars[i]!);
      }
      return out;
    }
    const a = hexToRgb(dimHex);
    const b = hexToRgb(brightHex);
    let out = '';
    for (let i = 0; i < n; i++) {
      const t = shimmerWeight(i - head, band);
      const hex = rgbToHex(
        Math.round(a.r + (b.r - a.r) * t),
        Math.round(a.g + (b.g - a.g) * t),
        Math.round(a.b + (b.b - a.b) * t),
      );
      out += `${fgAnsi(hex, this.mode)}${chars[i]!}`;
    }
    return `${out}\x1b[39m`;
  }

  bg(color: ThemeColor, text: string): string {
    const ansi = this.bgColors.get(color);
    if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
    return `${ansi}${text}\x1b[49m`;
  }

  /** 裸背景 SGR。清屏/清行请用 49m（OSC 11），不要用 bg 的真彩填充。 */
  bgSeq(color: ThemeColor): string {
    const ansi = this.bgColors.get(color);
    if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
    return ansi;
  }

  /**
   * 划词高亮样式。终端原生拖选就是「实心块 + 对比色文字」：块底是终端默认前景色，
   * 字色按块底明度取黑或白（Windows Terminal 的 ColorFix::GetLightness 规则）。
   *
   * 字色在这里现推而不是查色板：块底可被 `theme.json` 覆盖，写死字色会让深色块配上
   * 深色字（浅底同理），划词直接看不见文字。推出来的字色只在正文/画布两档里取，够用。
   *
   * ansi 模式返回 undefined，让 TuiAltScreen 退回反显（SGR 7）——块底直接取自终端的
   * 16 色主题，跟终端拖选的观感天然一致；自己上真彩反而盖掉用户的配色。
   */
  selectionStyle(): SelectionHighlight | undefined {
    if (this.mode === 'ansi') return undefined;
    const { r, g, b } = hexToRgb(this.palette.selectedBg);
    const blockIsLight = 0.299 * r + 0.587 * g + 0.114 * b >= 128;
    return { bg: this.bgSeq('selectedBg'), fg: this.fgSeq(blockIsLight ? 'bg' : 'text') };
  }

  bold(text: string): string {
    return sgr('\x1b[1m', '\x1b[22m', text);
  }

  italic(text: string): string {
    return sgr('\x1b[3m', '\x1b[23m', text);
  }

  underline(text: string): string {
    return sgr('\x1b[4m', '\x1b[24m', text);
  }

  strikethrough(text: string): string {
    return sgr('\x1b[9m', '\x1b[29m', text);
  }
}

export const theme = new Theme(PALETTE);

/** 启动时读 ~/.sph/theme.json，覆盖色板后重编译。坏文件静默忽略。 */
export function loadUserTheme(path: string): void {
  if (!existsSync(path)) return;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    overlayPalette(parsed as Record<string, unknown>);
    theme.recompile(PALETTE);
  } catch {
    // 主题是装饰；配错不该挡启动。
  }
}

/** OSC 11 用真 hex，256 色终端也能拿到 #141414，不跟 SGR 量化走。 */
export function oscSetCanvasBackground(): string {
  // ansi 模式下画布就是终端自己的底色——强行 OSC 11 反而把用户的主题盖掉。
  if (detectColorMode() === 'ansi') return '';
  return `\x1b]11;${PALETTE.bg}\x07`;
}

/** 退出 TUI 时还原终端默认底；1049l 不会自动清掉 OSC 11。 */
export function oscResetCanvasBackground(): string {
  return `\x1b]111\x07`;
}

const HEADING_COLORS = ['mdH1', 'mdH2', 'mdH3', 'mdH4', 'mdH5', 'mdH6'] as const;

export function getMarkdownTheme(): MarkdownTheme {
  return {
    heading: (text: string, depth = 2) => {
      const index = Math.min(HEADING_COLORS.length, Math.max(1, Math.floor(depth))) - 1;
      return theme.bold(theme.fg(HEADING_COLORS[index]!, text));
    },
    link: (text: string) => theme.underline(theme.fg('mdLink', text)),
    linkUrl: (text: string) => theme.fg('mdLinkUrl', text),
    // grok-build：行内码整段蓝、加粗，不做词法猜测。
    code: (text: string) => theme.bold(theme.fg('mdCode', text)),
    codeBlock: (text: string) => theme.fg('mdCodeBlock', text),
    // 围栏 ``` 与注释同为 #808080，但**刻意不叠斜体**：斜体留给注释，
    // 围栏是结构标记不是内容，叠斜体后整段代码的边界会糊掉。
    codeBlockBorder: (text: string) => theme.fg('mdCodeBlockBorder', text),
    quote: (text: string) => theme.fg('mdQuote', text),
    quoteBorder: (text: string) => theme.fg('mdQuoteBorder', text),
    hr: (text: string) => theme.fg('mdHr', text),
    listBullet: (text: string) => theme.fg('mdListBullet', text),
    bold: (text: string) => theme.bold(text),
    italic: (text: string) => theme.italic(theme.fg('muted', text)),
    emphasis: (text: string) => theme.italic(theme.fg('muted', text)),
    underline: (text: string) => theme.underline(text),
    strikethrough: (text: string) => theme.strikethrough(text),
  };
}

export function getSelectListTheme(): SelectListTheme {
  return {
    description: (text: string) => theme.fg('muted', text),
    scrollInfo: (text: string) => theme.fg('muted', text),
    noMatch: (text: string) => theme.fg('muted', text),
    selectedMark: (mark: string) => theme.fg('primary', mark),
    selectedRow: (text: string) => theme.bold(theme.fg('text', text)),
  };
}

export function getEditorTheme(): EditorTheme {
  return {
    borderColor: (text: string) => theme.fg('borderMuted', text),
    focusBorderColor: (text: string) => theme.fg('primary', text),
    selectList: getSelectListTheme(),
    // 菜单标题与浮层对话框同一套：主色加粗。颜色留在主题里，编辑器只接收画笔。
    menuTitle: (text: string) => theme.bold(theme.fg('primary', text)),
  };
}
