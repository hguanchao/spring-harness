/**
 * 主题：命名色板编译成 ANSI，组件只按名字取色。
 * 色板是编译期常量（见 palettes.ts），不读盘、不切换、不热加载。
 */

import type { EditorTheme, MarkdownTheme, SelectListTheme } from '../core/index.js';
import { colorIdeaInline } from '../syntax/idea-inline.js';
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

const HIGHLIGHT_CACHE_LIMIT = 32;
const highlightCache = new Map<string, string[]>();

/** 语法色对齐 IntelliJ Darcula：默认字 #a9b7c6，关键字橙、方法金、字符串绿。 */
const highlightTheme: Record<string, (text: string) => string> = {
  comment: (t) => theme.italic(theme.fg('syntaxComment', t)),
  doctag: (t) => theme.italic(theme.fg('syntaxComment', t)),
  quote: (t) => theme.italic(theme.fg('syntaxComment', t)),
  keyword: (t) => theme.fg('syntaxKeyword', t),
  'selector-tag': (t) => theme.fg('syntaxKeyword', t),
  'meta-keyword': (t) => theme.fg('syntaxKeyword', t),
  literal: (t) => theme.fg('syntaxNumber', t),
  'built_in': (t) => theme.fg('syntaxKeyword', t),
  title: (t) => theme.fg('syntaxFunction', t),
  function: (t) => theme.fg('syntaxFunction', t),
  variable: (t) => theme.fg('syntaxVariable', t),
  params: (t) => theme.fg('syntaxVariable', t),
  property: (t) => theme.fg('syntaxProperty', t),
  'template-variable': (t) => theme.fg('syntaxProperty', t),
  attr: (t) => theme.fg('syntaxProperty', t),
  attribute: (t) => theme.fg('syntaxProperty', t),
  'selector-id': (t) => theme.fg('syntaxProperty', t),
  'selector-class': (t) => theme.fg('syntaxProperty', t),
  string: (t) => theme.fg('syntaxString', t),
  subst: (t) => theme.fg('syntaxString', t),
  symbol: (t) => theme.fg('syntaxString', t),
  regexp: (t) => theme.fg('syntaxString', t),
  addition: (t) => theme.fg('syntaxString', t),
  deletion: (t) => theme.fg('error', t),
  number: (t) => theme.fg('syntaxNumber', t),
  type: (t) => theme.bold(theme.fg('syntaxType', t)),
  class: (t) => theme.bold(theme.fg('syntaxType', t)),
  operator: (t) => theme.fg('syntaxOperator', t),
  punctuation: (t) => theme.fg('syntaxPunctuation', t),
  tag: (t) => theme.fg('syntaxKeyword', t),
  name: (t) => theme.fg('syntaxKeyword', t),
  bullet: (t) => theme.fg('syntaxKeyword', t),
  meta: (t) => theme.fg('syntaxAnnotation', t),
  default: (t) => theme.fg('mdCodeBlock', t),
};

/** grok-build：无语言标记或 text/plaintext 的围栏不当代码高亮，整块走正文色。 */
const UNTAGGED_LANGS = new Set(['plaintext', 'text', 'txt', 'output', 'ansi', 'console', 'raw']);

const ideaInlineColors = {
  keyword: (t: string) => theme.fg('syntaxKeyword', t),
  method: (t: string) => theme.fg('syntaxFunction', t),
  constant: (t: string) => theme.fg('syntaxProperty', t),
  annotation: (t: string) => theme.fg('syntaxAnnotation', t),
  string: (t: string) => theme.fg('syntaxString', t),
  number: (t: string) => theme.fg('syntaxNumber', t),
  comment: (t: string) => theme.italic(theme.fg('syntaxComment', t)),
  identifier: (t: string) => theme.fg('mdCodeBlock', t),
};

function fallbackCodeLines(code: string): string[] {
  return code.split('\n').map((line) => colorIdeaInline(line, ideaInlineColors));
}

/**
 * 高亮代码块。对齐 grok-build：
 * - 无语言 / text / plaintext / console 等：不上语法色，整块代码默认字 #a9b7c6；
 * - 未知语言：同样不上色，不做 highlightAuto（会把树状图、散文猜成某种语言）。
 *
 * 结果按 (语言, 正文) 缓存：流式重建时已闭合的块几乎不再变，避免每帧重跑 highlight.js。
 */
export function highlightCode(code: string, lang?: string): string[] {
  const validLang = normalizeLanguage(lang);
  if (!validLang || UNTAGGED_LANGS.has(validLang)) return fallbackCodeLines(code);
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
    return fallbackCodeLines(code);
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
    code: (text: string) => colorIdeaInline(text, ideaInlineColors),
    codeBlock: (text: string) => theme.fg('mdCodeBlock', text),
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
    // 选中行整行底色（入参已是补齐宽度的纯文本）：底色即选中的视觉锚点，
    // 行内不再叠加前景码，避免其中的 reset 把底色截断。
    selectedRow: (text: string) => theme.bg('selectedBg', text),
  };
}

export function getEditorTheme(): EditorTheme {
  return {
    borderColor: (text: string) => theme.fg('borderMuted', text),
    selectList: getSelectListTheme(),
  };
}
