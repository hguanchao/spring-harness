/**
 * 主题：命名色板编译成 ANSI，组件只按名字取色。
 * 色板是编译期常量（见 palettes.ts），不读盘、不切换、不热加载。
 */

import type { EditorTheme, MarkdownTheme, SelectListTheme } from '../core/index.js';
import { highlight, normalizeLanguage } from '../syntax/highlight.js';
import { PALETTE, type ThemeColor } from './palettes.js';

export type { ThemeColor };
export type ColorMode = 'truecolor' | '256color';

let colorEnabled = detectColorEnabled();

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
  const colorterm = (process.env.COLORTERM ?? '').toLowerCase();
  if (colorterm.includes('truecolor') || colorterm.includes('24bit')) return 'truecolor';
  const term = (process.env.TERM ?? '').toLowerCase();
  if (term.includes('direct')) return 'truecolor';
  return '256color';
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

  constructor(palette: Record<string, string>, mode: ColorMode = detectColorMode()) {
    for (const [key, value] of Object.entries(palette)) {
      this.fgColors.set(key, fgAnsi(value, mode));
      this.bgColors.set(key, bgAnsi(value, mode));
    }
  }

  fg(color: ThemeColor, text: string): string {
    const ansi = this.fgColors.get(color);
    if (!ansi) throw new Error(`Unknown theme color: ${color}`);
    return `${ansi}${text}\x1b[39m`;
  }

  bg(color: ThemeColor, text: string): string {
    const ansi = this.bgColors.get(color);
    if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
    return `${ansi}${text}\x1b[49m`;
  }

  /** 裸背景 SGR，给清屏/清行用。不能包 49m，否则 2K 填回默认底。 */
  bgSeq(color: ThemeColor): string {
    const ansi = this.bgColors.get(color);
    if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
    return ansi;
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

/** OSC 11 用真 hex，256 色终端也能拿到 #141414，不跟 SGR 量化走。 */
export function oscSetCanvasBackground(): string {
  return `\x1b]11;${PALETTE.bg}\x07`;
}

/** 退出 TUI 时还原终端默认底；1049l 不会自动清掉 OSC 11。 */
export function oscResetCanvasBackground(): string {
  return `\x1b]111\x07`;
}

const HIGHLIGHT_CACHE_LIMIT = 32;
const highlightCache = new Map<string, string[]>();

/**
 * 带语言围栏的 scope → 色。只有关键字/函数/字符串/类型走蓝，其余归中性灰。
 * 行内码不走这张表。
 */
const highlightTheme: Record<string, (text: string) => string> = {
  comment: (t) => theme.italic(theme.fg('syntaxComment', t)),
  doctag: (t) => theme.italic(theme.fg('syntaxComment', t)),
  quote: (t) => theme.italic(theme.fg('syntaxComment', t)),
  keyword: (t) => theme.fg('syntaxKeyword', t),
  'selector-tag': (t) => theme.fg('syntaxKeyword', t),
  'meta-keyword': (t) => theme.fg('syntaxKeyword', t),
  literal: (t) => theme.fg('syntaxKeyword', t),
  'built_in': (t) => theme.fg('syntaxKeyword', t),
  title: (t) => theme.fg('syntaxFunction', t),
  function: (t) => theme.fg('syntaxFunction', t),
  variable: (t) => theme.fg('mdCodeBlock', t),
  params: (t) => theme.fg('mdCodeBlock', t),
  property: (t) => theme.fg('mdCodeBlock', t),
  'template-variable': (t) => theme.fg('mdCodeBlock', t),
  attr: (t) => theme.fg('mdCodeBlock', t),
  attribute: (t) => theme.fg('mdCodeBlock', t),
  'selector-id': (t) => theme.fg('mdCodeBlock', t),
  'selector-class': (t) => theme.fg('mdCodeBlock', t),
  string: (t) => theme.fg('syntaxString', t),
  subst: (t) => theme.fg('syntaxString', t),
  symbol: (t) => theme.fg('syntaxString', t),
  regexp: (t) => theme.fg('syntaxString', t),
  addition: (t) => theme.fg('syntaxString', t),
  deletion: (t) => theme.fg('mdCodeBlock', t),
  number: (t) => theme.fg('syntaxKeyword', t),
  type: (t) => theme.bold(theme.fg('syntaxFunction', t)),
  class: (t) => theme.bold(theme.fg('syntaxFunction', t)),
  operator: (t) => theme.fg('mdCodeBlock', t),
  punctuation: (t) => theme.fg('mdCodeBlock', t),
  tag: (t) => theme.fg('syntaxKeyword', t),
  name: (t) => theme.fg('syntaxKeyword', t),
  bullet: (t) => theme.fg('syntaxKeyword', t),
  meta: (t) => theme.fg('syntaxAnnotation', t),
  default: (t) => theme.fg('mdCodeBlock', t),
};

/** grok-build：无语言标记或 text/plaintext 的围栏不当代码高亮，整块走中性灰。 */
const UNTAGGED_LANGS = new Set(['plaintext', 'text', 'txt', 'output', 'ansi', 'console', 'raw']);

/**
 * 无标签围栏：不对词法、不上蓝，整块中性灰。
 * 目录树/配置片段是代码块，不该跟正文一样亮。
 */
function plainCodeLines(code: string): string[] {
  return code.split('\n').map((line) => theme.fg('mdCodeBlock', line));
}

/**
 * 高亮代码块。无语言 / text / 未知语言整块中性灰，不猜词法；
 * 只有 highlight.js 认得出的语言标签才上蓝色语法色。
 */
export function highlightCode(code: string, lang?: string): string[] {
  const validLang = normalizeLanguage(lang);
  if (!validLang || UNTAGGED_LANGS.has(validLang)) return plainCodeLines(code);
  const key = `${validLang}\0${code}`;
  const cached = highlightCache.get(key);
  if (cached) {
    highlightCache.delete(key);
    highlightCache.set(key, cached);
    return cached;
  }
  try {
    const lines = highlight(code, { language: validLang, ignoreIllegals: true, theme: highlightTheme }).split('\n');
    highlightCache.set(key, lines);
    if (highlightCache.size > HIGHLIGHT_CACHE_LIMIT) {
      const oldest = highlightCache.keys().next().value;
      if (oldest !== undefined) highlightCache.delete(oldest);
    }
    return lines;
  } catch {
    // highlight.js 抛错时同样整块走中性灰：半块蓝半块灰比全灰更难读。
    return plainCodeLines(code);
  }
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
    highlightCode: (code: string, lang?: string): string[] => highlightCode(code, lang),
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
    selectList: getSelectListTheme(),
  };
}
