/**
 * Markdown → 终端行（纯函数，无 IO、无 TTY 依赖，可直接在测试里断言）。
 *
 * 三层：
 *   parseBlocks    块级解析 —— 行导向，容忍半截输入（流式时围栏可能还没闭合）
 *   parseInline    行内解析 —— 输出 span 列表，而不是「已经着色的字符串」
 *   renderMarkdown 宽度感知排版 —— 保证每行 displayWidth <= width
 *
 * 为什么折行必须做在 span 流上：带样式的文本一旦先拼成字符串再折行，跨行时就得重新发
 * 一遍 SGR、并在行尾复位；在字符串上做这件事等于把转义序列重新解析一遍。span 流天然
 * 知道每一段该用什么样式，每行独立生成、自成一体。
 *
 * 为什么不能复用 ansi.wrap：它会丢掉行首空格（对普通段落是清理，对 markdown 是灾难）——
 * 嵌套列表、引用、代码块的缩进语义全在那里。见 wrapSpans。
 *
 * 明确不做（遇到就原样显示语法字符，而不是猜）：
 *   内嵌 HTML、引用式链接定义、setext 标题、缩进式代码块、实体转义、脚注。
 * 这样最坏情况是「看到 | a | b |」，绝不会是渲染错位或吃掉一行。
 *
 * 色彩语义沿用 view.ts 的约定：标题/链接/行内码用 cyan，引用与元信息用 dim，
 * 加粗/斜体/删除线只用 SGR 属性、不额外消耗色相。
 */

import { clusters, displayWidth, sanitize, type Styler } from './ansi.js';

// ---------------------------------------------------------------- 类型

/** 渲染期色调：决定一个 span 归到哪一类颜色。语法高亮的 token 也走这一条通路。 */
export type Tone =
  | 'plain'
  | 'accent'
  | 'muted'
  | 'comment'
  | 'string'
  | 'number'
  | 'keyword'
  | 'type'
  | 'function'
  | 'operator'
  | 'added'
  | 'removed'
  | 'meta';

/** 行内样式：一组标记位，渲染时逐项叠加成 SGR。 */
export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  /** 行内代码：等宽语义，终端里用 cyan 表达。 */
  code?: boolean;
  strike?: boolean;
  underline?: boolean;
  /** 链接目标（非空）。正文加下划线，并另行展示目标。 */
  link?: string;
  /** 渲染期色调，不参与解析。 */
  tone?: Tone;
}

export type SpanStyle = Omit<Span, 'text'>;

export type Align = 'left' | 'center' | 'right';

export interface ListItem {
  /** 嵌套深度（0 起）。 */
  depth: number;
  /** 无序列表用 `-`，有序列表用原样序号 `1.`。 */
  marker: string;
  /** 任务列表的勾选态；非任务项为 undefined。 */
  task?: boolean;
  spans: Span[];
}

export interface TableBlock {
  kind: 'table';
  header: Span[][];
  rows: Span[][][];
  aligns: Align[];
}

export type Block =
  | { kind: 'heading'; level: number; spans: Span[] }
  | { kind: 'paragraph'; lines: Span[][] }
  | { kind: 'code'; lang: string; lines: string[]; closed: boolean }
  | { kind: 'list'; ordered: boolean; items: ListItem[] }
  | { kind: 'quote'; lines: Span[][] }
  | { kind: 'rule' }
  | TableBlock;

/** 代码块着色器：由调用方提供（见 highlight.ts），保持本模块不依赖任何语言规则。 */
export interface LineHighlighter {
  line(text: string): Span[];
}

export interface MarkdownOptions {
  width: number;
  styler: Styler;
  /** 整体缩进列数。 */
  indent?: number;
  /** 首行前缀（用户消息的 `> `），续行用等宽空格对齐。 */
  prefix?: string;
  /** 为代码块创建着色器；返回 undefined 表示该语言按纯文本渲染。 */
  highlighter?: (lang: string) => LineHighlighter | undefined;
  /** 是否在链接正文后展示目标（默认关：窄终端下容易挤掉正文）。 */
  showLinks?: boolean;
  /** 表格放不下时：wrap（默认，折行不丢内容）或 truncate（一行一行，超出打 `...`）。 */
  tableOverflow?: 'wrap' | 'truncate';
  /** 表格边框：ascii（默认 `+--+`）或 box（Unicode 制表符）。 */
  tableBorder?: 'ascii' | 'box';
}

// ---------------------------------------------------------------- 行内解析

interface Emphasis {
  mark: string;
  style: SpanStyle;
}

/** 顺序有意义：先匹配更长的定界符，否则 `***x***` 会被 `*` 抢先。 */
const EMPHASIS: readonly Emphasis[] = [
  { mark: '***', style: { bold: true, italic: true } },
  { mark: '**', style: { bold: true } },
  { mark: '__', style: { bold: true } },
  { mark: '~~', style: { strike: true } },
  { mark: '*', style: { italic: true } },
  { mark: '_', style: { italic: true } },
];

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
}

function styleKey(s: SpanStyle): string {
  return `${s.bold ? 1 : 0}${s.italic ? 1 : 0}${s.code ? 1 : 0}${s.strike ? 1 : 0}${s.underline ? 1 : 0}|${s.link ?? ''}|${s.tone ?? ''}`;
}

/** 追加一段文本，与上一段样式相同则合并（减少 span 数量，也减少 SGR 切换）。 */
function push(out: Span[], text: string, style: SpanStyle): void {
  if (text === '') return;
  const last = out[out.length - 1];
  if (last && styleKey(last) === styleKey(style)) {
    last.text += text;
    return;
  }
  out.push({ ...style, text });
}

/** 找闭合定界符。闭合符左侧不能是空白（否则是字面量）。 */
function findClosing(rest: string, mark: string): number {
  for (let i = mark.length; i <= rest.length - mark.length; i++) {
    if (!rest.startsWith(mark, i)) continue;
    const before = rest[i - 1];
    if (before === ' ' || before === '\t' || before === '\n') continue;
    return i;
  }
  return -1;
}

function matchEmphasis(text: string, at: number): { inner: string; end: number; style: SpanStyle } | null {
  const rest = text.slice(at);
  for (const { mark, style } of EMPHASIS) {
    if (!rest.startsWith(mark)) continue;
    const after = rest[mark.length];
    if (after === undefined || after === ' ' || after === '\t' || after === '\n') continue;
    // `_` 必须落在词边界上，否则 `snake_case_name` 会被吃掉一半。
    if (mark === '_' && isWordChar(at === 0 ? undefined : text[at - 1])) continue;
    const close = findClosing(rest, mark);
    if (close === -1) continue;
    const inner = rest.slice(mark.length, close);
    if (inner.trim() === '') continue;
    return { inner, end: at + close + mark.length, style };
  }
  return null;
}

function matchLink(text: string, at: number): { label: string; url: string; end: number } | null {
  const m = /^\[([^\]\n]*)\]\(([^)\s]*)(?:[ \t]+"[^"]*")?\)/.exec(text.slice(at));
  if (!m) return null;
  const url = m[2] ?? '';
  if (url === '') return null;
  const label = m[1] ?? '';
  return { label: label === '' ? url : label, url, end: at + m[0].length };
}

/** 行内解析：把一段文本切成带样式的 span 序列。 */
export function parseInline(text: string): Span[] {
  const out: Span[] = [];
  scanInline(text, {}, out, 0);
  return out;
}

function scanInline(text: string, style: SpanStyle, out: Span[], depth: number): void {
  if (depth > 6) {
    push(out, text, style);
    return;
  }
  let literal = '';
  const flush = (): void => {
    if (literal !== '') {
      push(out, literal, style);
      literal = '';
    }
  };

  for (let i = 0; i < text.length; ) {
    const ch = text[i]!;

    // 反斜杠转义：被转义的标点按字面输出。
    if (ch === '\\' && i + 1 < text.length && /[\\`*_{}[\]()#+\-.!~>|]/.test(text[i + 1]!)) {
      literal += text[i + 1];
      i += 2;
      continue;
    }

    // 行内代码：内部一律字面，不再做任何解析。
    if (ch === '`') {
      const run = /^`+/.exec(text.slice(i))![0];
      const end = text.indexOf(run, i + run.length);
      if (end !== -1) {
        flush();
        // CommonMark 允许 `` `code` `` 两侧各留一个空格来保护首尾反引号。
        let inner = text.slice(i + run.length, end);
        if (inner.length > 2 && inner.startsWith(' ') && inner.endsWith(' ')) inner = inner.slice(1, -1);
        push(out, inner, { ...style, code: true });
        i = end + run.length;
        continue;
      }
    }

    if (ch === '[') {
      const link = matchLink(text, i);
      if (link) {
        flush();
        scanInline(link.label, { ...style, link: link.url }, out, depth + 1);
        i = link.end;
        continue;
      }
    }

    const emph = matchEmphasis(text, i);
    if (emph) {
      flush();
      scanInline(emph.inner, { ...style, ...emph.style }, out, depth + 1);
      i = emph.end;
      continue;
    }

    literal += ch;
    i++;
  }
  flush();
}

// ---------------------------------------------------------------- 块级解析

const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/;
const HEADING = /^[ \t]{0,3}(#{1,6})[ \t]+(.*)$/;
const RULE = /^[ \t]{0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const BULLET = /^([ \t]*)([-*+])[ \t]+(.*)$/;
const ORDERED = /^([ \t]*)(\d{1,9})[.)][ \t]+(.*)$/;
const TASK = /^\[([ xX])\][ \t]+(.*)$/;
const QUOTE = /^[ \t]{0,3}>[ \t]?(.*)$/;

/** 拆表格行：处理 `\|` 转义，去掉首尾竖线。 */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (s[i] === '|') {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

function isDelimiterRow(line: string): boolean {
  if (!line.includes('-')) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return 'left';
}

/** 块级解析：行导向，能容忍半截输入（流式时最后一块可能还没结束）。 */
export function parseBlocks(text: string): Block[] {
  const lines = sanitize(text).split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1]!;
      const lang = (fence[2] ?? '').trim();
      const body: string[] = [];
      const closer = new RegExp(`^[ \\t]{0,3}\\${mark[0]}{${mark.length},}[ \\t]*$`);
      i++;
      let closed = false;
      while (i < lines.length) {
        if (closer.test(lines[i]!)) {
          closed = true;
          i++;
          break;
        }
        body.push(lines[i]!);
        i++;
      }
      blocks.push({ kind: 'code', lang, lines: body, closed });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const raw = heading[2]!.replace(/[ \t]+#+[ \t]*$/, '');
      blocks.push({ kind: 'heading', level: heading[1]!.length, spans: parseInline(raw) });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      i++;
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && isDelimiterRow(lines[i + 1]!)) {
      const header = splitRow(line).map(parseInline);
      const aligns = splitRow(lines[i + 1]!).map(alignOf);
      i += 2;
      const rows: Span[][][] = [];
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') {
        rows.push(splitRow(lines[i]!).map(parseInline));
        i++;
      }
      blocks.push({ kind: 'table', header, rows, aligns });
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: Span[][] = [];
      while (i < lines.length) {
        const m = QUOTE.exec(lines[i]!);
        if (!m) break;
        quoted.push(parseInline(m[1]!));
        i++;
      }
      blocks.push({ kind: 'quote', lines: quoted });
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    if (bullet || ordered) {
      const items: ListItem[] = [];
      while (i < lines.length) {
        const b = BULLET.exec(lines[i]!);
        const o = b ? null : ORDERED.exec(lines[i]!);
        if (!b && !o) break;
        const indent = (b ? b[1]! : o![1]!).length;
        let content = b ? b[3]! : o![3]!;
        let task: boolean | undefined;
        const t = TASK.exec(content);
        if (t) {
          task = t[1] !== ' ';
          content = t[2]!;
        }
        items.push({
          // 每两级缩进算一层：实践中 2 空格与 4 空格缩进都常见，取整更宽容。
          depth: Math.min(5, Math.floor(indent / 2)),
          marker: b ? '-' : `${o![2]}.`,
          task,
          spans: parseInline(content),
        });
        i++;
      }
      blocks.push({ kind: 'list', ordered: ordered !== null, items });
      continue;
    }

    // 段落：吃到空行或下一个块的起点。
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i]!;
      if (l.trim() === '') break;
      if (FENCE.test(l) || HEADING.test(l) || RULE.test(l) || QUOTE.test(l) || BULLET.test(l) || ORDERED.test(l)) break;
      if (l.includes('|') && i + 1 < lines.length && isDelimiterRow(lines[i + 1]!)) break;
      para.push(l.trim());
      i++;
    }
    if (para.length > 0) blocks.push({ kind: 'paragraph', lines: para.map(parseInline) });
  }

  return blocks;
}

// ---------------------------------------------------------------- 排版

/**
 * 把一个超宽 token 切成多行。
 *
 * 优先在「软断点」后断开：`/ - _ .` 这些字符后面本来就是天然的视觉边界，
 * `src/agent/compact.ts` 断成 `src/agent/` + `compact.ts` 远比 `src/agen` + `t/compact` 可读。
 * 找不到软断点（base64、长数字串）才按宽度硬切。
 */
function hardSplit(text: string, limit: number): string[] {
  const out: string[] = [];
  let cur = '';
  let width = 0;
  let breakAt = -1;
  for (const c of clusters(text)) {
    if (width + c.width > limit && cur !== '') {
      // 断点字符归属于上一行（`src/agent/` 而不是 `src/agent` + `/compact`）。
      const cut = breakAt > 0 && breakAt < cur.length ? breakAt : cur.length;
      out.push(cur.slice(0, cut));
      cur = cur.slice(cut);
      width = displayWidth(cur);
      breakAt = -1;
    }
    cur += c.ch;
    width += c.width;
    if ('/-_.'.includes(c.ch)) breakAt = cur.length;
  }
  if (cur !== '') out.push(cur);
  return out.length === 0 ? [''] : out;
}

function trimLine(line: readonly Span[]): Span[] {
  const out = line.map((s) => ({ ...s }));
  while (out.length > 0) {
    const last = out[out.length - 1]!;
    const trimmed = last.text.replace(/[ \t]+$/, '');
    if (trimmed === last.text) break;
    if (trimmed === '') out.pop();
    else last.text = trimmed;
  }
  return out;
}

/**
 * 把 span 流按宽度贪婪折成多行。
 *
 * 与 ansi.wrap 的关键差别：**保留段内空白与行首缩进**。空白是「待定」的——只有后面还
 * 接得上内容才落到行尾，因此不会留下行尾空格，也不会在窄宽度下推出一串空行。
 */
export function wrapSpans(spans: readonly Span[], width: number): Span[][] {
  const limit = Math.max(1, Math.floor(width));
  const lines: Span[][] = [[]];
  let pending: Span | null = null;

  const current = (): Span[] => lines[lines.length - 1]!;
  const used = (): number => current().reduce((n, s) => n + displayWidth(s.text), 0);
  const append = (text: string, style: SpanStyle): void => {
    if (text === '') return;
    push(current(), text, style);
  };
  const flushPending = (): void => {
    if (pending) {
      append(pending.text, pending);
      pending = null;
    }
  };

  for (const span of spans) {
    for (const token of span.text.match(/[ \t]+|[^ \t]+/g) ?? []) {
      if (/^[ \t]+$/.test(token)) {
        if (used() > 0 || pending) pending = { ...span, text: token };
        continue;
      }
      const tokenWidth = displayWidth(token);
      if (tokenWidth > limit) {
        // 超宽长串（CJK 段落、长路径、base64）只能硬切。
        flushPending();
        if (used() > 0) lines.push([]);
        const pieces = hardSplit(token, limit);
        for (let k = 0; k < pieces.length; k++) {
          if (k > 0) lines.push([]);
          append(pieces[k]!, span);
        }
        continue;
      }
      const spaceWidth = pending ? displayWidth(pending.text) : 0;
      if (used() > 0 && used() + spaceWidth + tokenWidth > limit) {
        pending = null;
        lines.push([]);
      }
      flushPending();
      append(token, span);
    }
  }
  pending = null;
  return lines.map(trimLine).filter((l, idx) => !(l.length === 0 && lines.length > 1 && idx === lines.length - 1));
}

/** 按显示宽度裁剪 span 流；样式保持完整（不产生半截 SGR）。 */
export function clipSpans(spans: readonly Span[], width: number): { spans: Span[]; clipped: boolean } {
  const limit = Math.max(0, Math.floor(width));
  const out: Span[] = [];
  let used = 0;
  for (const s of spans) {
    let text = '';
    for (const c of clusters(s.text)) {
      if (used + c.width > limit) {
        if (text !== '') out.push({ ...s, text });
        return { spans: out, clipped: true };
      }
      text += c.ch;
      used += c.width;
    }
    if (text !== '') out.push({ ...s, text });
  }
  return { spans: out, clipped: false };
}

export function spanWidth(spans: readonly Span[]): number {
  return spans.reduce((n, s) => n + displayWidth(s.text), 0);
}

/** span 流 → 着色字符串。每个 span 是叶子，因此「内层 reset」不会截断外层样式。 */
export function paintSpans(spans: readonly Span[], styler: Styler): string {
  return spans.map((s) => paintSpan(s, styler)).join('');
}

function paintSpan(s: Span, styler: Styler): string {
  let text = s.text;
  if (s.code || s.link !== undefined) {
    text = styler.cyan(text);
  } else {
    // 色调 → 颜色集中在这一张表里：换配色只改这里，不用翻遍渲染代码。
    switch (s.tone ?? 'plain') {
      case 'accent':
      case 'keyword':
      case 'type':
      case 'function':
      case 'meta':
        text = styler.cyan(text);
        break;
      case 'muted':
      case 'comment':
      case 'operator':
        text = styler.dim(text);
        break;
      case 'string':
      case 'added':
        text = styler.green(text);
        break;
      case 'number':
        text = styler.yellow(text);
        break;
      case 'removed':
        text = styler.red(text);
        break;
      default:
        break;
    }
  }
  if (s.underline || s.link !== undefined) text = styler.underline(text);
  if (s.bold) text = styler.bold(text);
  if (s.italic) text = styler.italic(text);
  if (s.strike) text = styler.strike(text);
  return text;
}

/** 列宽下限：低于它就只剩「一格里塞两三个字符」，读起来比折行更糟。 */
const MIN_COL = 3;
/** 「够用宽度」上限：超过这个宽度的列再宽也只是少折几行，不值得从别列抢预算。 */
const USEFUL_CAP = 32;

/** 一列里最长的不可断词（按空白切分）的显示宽度——列宽至少给到它，词才不会被劈开。 */
function longestWord(cells: readonly Span[][]): number {
  let width = 0;
  for (const cell of cells) {
    for (const span of cell) {
      for (const token of span.text.split(/\s+/)) {
        width = Math.max(width, displayWidth(token));
      }
    }
  }
  return width;
}

/**
 * 列宽分配。
 *
 * 旧实现只按「自然宽比例」收缩，结果 `Lines` / `Risk` / `Owner` 这类短列被压到 3~5 列，
 * 单词被硬切成 `Line/s`、`Ris/k`——表格里最难读的形态。现在分两步：
 *
 * 1. 先满足每列的「够用宽度」= min(最长词, 自然宽, USEFUL_CAP)。短列到此就不再抢预算，
 *    词能整放；长文本列照常折行。
 * 2. 剩余预算按「离自然宽还差多少」的比例补回去，仍然优先补内容多的列。
 *
 * 连够用宽度都放不下（列太多 / 窗口太窄）时才退回按比例收缩，并保证总宽不超预算。
 */
function allocate(natural: readonly number[], useful: readonly number[], budget: number): number[] {
  const columns = natural.length;
  if (columns === 0) return [];
  const target = natural.map((value, i) =>
    Math.min(value, Math.max(MIN_COL, Math.min(useful[i] ?? MIN_COL, USEFUL_CAP))),
  );
  const targetTotal = target.reduce((a, b) => a + b, 0);
  if (targetTotal <= budget) {
    const spare = budget - targetTotal;
    const headroom = natural.map((value, i) => Math.max(0, value - (target[i] ?? 0)));
    const headroomTotal = headroom.reduce((a, b) => a + b, 0);
    if (headroomTotal === 0) return [...target];
    return natural.map((value, i) =>
      Math.min(value, (target[i] ?? 0) + Math.floor(((headroom[i] ?? 0) / headroomTotal) * spare)),
    );
  }

  const total = natural.reduce((a, b) => a + b, 0);
  if (total <= budget) return [...natural];
  return fitToBudget(waterFill(natural, budget), budget);
}

/**
 * 水位法：按「自然宽从小到大」依次满足，每列拿到「剩余预算 ÷ 剩余列数」与自身需求中较小的那个。
 *
 * 挤不下「够用宽度」时（列多 / 窗口窄），按内容比例收缩会让短列只剩 2~3 列，
 * 而长文本列独占十几列——`Risk` 被切成 `Ris/k`、`Owner` 切成 `Owne/r`。
 * 水位法保证每列先拿到均分份额，短列能整词放下，剩余预算再给内容多的列。
 */
function waterFill(natural: readonly number[], budget: number): number[] {
  const order = natural.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const widths = new Array<number>(natural.length).fill(0);
  let remaining = budget;
  let taken = 0;
  for (const { value, index } of order) {
    const share = Math.floor(remaining / Math.max(1, natural.length - taken));
    const give = Math.max(1, Math.min(value, share));
    widths[index] = give;
    remaining -= give;
    taken++;
  }
  return widths;
}

/** 最后一道防线：总宽绝不超过预算。超了就从最宽的列往下削，否则整行会被调用方裁掉一截。 */
function fitToBudget(widths: readonly number[], budget: number): number[] {
  const out = [...widths];
  let total = out.reduce((a, b) => a + b, 0);
  while (total > budget) {
    let widest = 0;
    for (let i = 1; i < out.length; i++) {
      if ((out[i] ?? 0) > (out[widest] ?? 0)) widest = i;
    }
    if ((out[widest] ?? 0) <= 1) break;
    out[widest] = (out[widest] ?? 0) - 1;
    total--;
  }
  return out;
}

/** 一行原始单元格 → 「a | b | c」的 span 流（降级渲染用）。 */
function joinRow(cells: readonly Span[][], columns: number): Span[] {
  const out: Span[] = [];
  for (let c = 0; c < columns; c++) {
    if (c > 0) out.push({ text: ' | ', tone: 'muted' });
    out.push(...(cells[c] ?? []));
  }
  return out;
}

function renderTable(
  block: TableBlock,
  width: number,
  lead: string,
  styler: Styler,
  overflow: 'wrap' | 'truncate',
  border: 'ascii' | 'box',
): string[] {
  const columns = Math.max(block.header.length, ...block.rows.map((r) => r.length), 1);
  const cellOf = (row: readonly Span[][] | undefined, c: number): Span[] => row?.[c] ?? [];

  // 边框与内边距的固定开销：`| a | b |` = 列数 * 3 + 1。
  const inner = Math.max(1, width - displayWidth(lead));
  const fixed = columns * 3 + 1;

  // 窄到「每列连一个字符都放不下」时，网格只会被裁掉右半边。这时按行折行输出，
  // 牺牲表格外观、保住全部内容——与「单元格折行不截断」是同一个取舍。
  if (inner < fixed + columns) {
    const lines: string[] = [];
    for (const row of [block.header, ...block.rows]) {
      const flat = joinRow(row, columns);
      if (flat.length === 0) continue;
      lines.push(...wrapSpans(flat, inner).map((spans) => `${lead}${paintSpans(spans, styler)}`));
    }
    return lines;
  }

  const budget = inner - fixed;
  const natural: number[] = [];
  const useful: number[] = [];
  for (let c = 0; c < columns; c++) {
    const cells = [cellOf(block.header, c), ...block.rows.map((row) => cellOf(row, c))];
    let w = 0;
    for (const cell of cells) w = Math.max(w, spanWidth(cell));
    natural.push(Math.max(1, w));
    useful.push(longestWord(cells));
  }
  const widths = allocate(natural, useful, budget);

  // 边框字符集。box 更接近现代终端工具的观感，但制表符是东亚歧义宽度字符，
  // 在部分终端按 2 列渲染会撑破整行——所以默认仍是 ASCII（见文件头与 view.ts 的宽度不变量）。
  const chars = border === 'box'
    ? { v: '│', h: '─', tl: '┌', tm: '┬', tr: '┐', ml: '├', mm: '┼', mr: '┤', bl: '└', bm: '┴', br: '┘' }
    : { v: '|', h: '-', tl: '+', tm: '+', tr: '+', ml: '+', mm: '+', mr: '+', bl: '+', bm: '+', br: '+' };
  const rule = (left: string, mid: string, right: string): string =>
    `${lead}${styler.dim(`${left}${widths.map((w) => chars.h.repeat(w + 2)).join(mid)}${right}`)}`;

  /**
   * 一行表格 → 若干屏幕行。**单元格折行，绝不截断**。
   *
   * 原来这里是「裁到列宽 + 打一个 `~`」：终端里表格一窄就把内容吃掉半截，而表格恰恰常用来
   * 罗列长清单（工具名、参数、状态），被裁掉的那半往往才是信息。模型输出什么就显示什么 ——
   * 宽度不够时让这一行长高，而不是丢内容；对话流本来就支持任意高度。
   *
   * 行高取该行各单元格折行数的最大值，矮的单元格补空格对齐，网格仍然规整。
   */
  const rowLines = (cells: readonly Span[][], header: boolean): string[] => {
    const decorated = (raw: Span[]): Span[] => (header ? raw.map((s) => ({ ...s, bold: true })) : raw);
    const wrapped = widths.map((w, c) => wrapSpans(decorated(cellOf(cells, c)), w));
    const height = overflow === 'truncate' ? 1 : Math.max(1, ...wrapped.map((lines) => lines.length));
    const out: string[] = [];
    for (let i = 0; i < height; i++) {
      const parts: string[] = [];
      for (let c = 0; c < columns; c++) {
        const limit = widths[c] ?? 1;
        const align = block.aligns[c] ?? 'left';
        let line = wrapped[c]?.[i] ?? [];
        let ellipsis = false;
        if (overflow === 'truncate' && (wrapped[c]?.length ?? 0) > 1) {
          line = clipSpans(line, Math.max(0, limit - 3)).spans;
          ellipsis = true;
        }
        const text = paintSpans(line, styler) + (ellipsis ? styler.dim('...') : '');
        const gap = Math.max(0, limit - spanWidth(line) - (ellipsis ? 3 : 0));
        const left = align === 'right' ? ' '.repeat(gap) : align === 'center' ? ' '.repeat(Math.floor(gap / 2)) : '';
        const right = align === 'center' ? ' '.repeat(gap - Math.floor(gap / 2)) : '';
        parts.push(`${left} ${text}${align === 'left' ? ' '.repeat(gap) : right} `);
      }
      out.push(`${lead}${styler.dim(chars.v)}${parts.join(styler.dim(chars.v))}${styler.dim(chars.v)}`);
    }
    return out;
  };

  const out = [rule(chars.tl, chars.tm, chars.tr), ...rowLines(block.header, true), rule(chars.ml, chars.mm, chars.mr)];
  for (const row of block.rows) out.push(...rowLines(row, false));
  // 没有数据行时不再补一条底线：否则表头下面会出现两条一模一样的 `+---+`。
  if (block.rows.length > 0) out.push(rule(chars.bl, chars.bm, chars.br));
  return out;
}

/** 把 markdown 文本渲染成屏幕行；每行的 displayWidth 都 <= width。 */
export function renderMarkdown(text: string, options: MarkdownOptions): string[] {
  const { styler } = options;
  const width = Math.max(4, Math.floor(options.width));
  const lead = `${' '.repeat(Math.max(0, options.indent ?? 0))}${options.prefix ?? ''}`;
  const leadWidth = displayWidth(lead);
  const inner = Math.max(4, width - leadWidth);
  const out: string[] = [];
  const blocks = parseBlocks(text);
  let first = true;

  /** 块前留一个空行，但不在开头留。 */
  const gap = (): void => {
    if (!first) out.push('');
  };
  const paint = (spans: readonly Span[]): string => paintSpans(spans, styler);

  for (const block of blocks) {
    switch (block.kind) {
      case 'heading': {
        gap();
        // 层级只用 SGR 属性区分：h1 额外下划线，其余靠加粗 —— 不消耗色相，
        // 单色终端下同样成立。
        const styled = block.spans.map((s) => ({
          ...s,
          tone: 'accent' as const,
          bold: true,
          code: false,
          underline: block.level === 1 || s.underline === true,
        }));
        for (const row of wrapSpans(styled, inner)) out.push(`${lead}${paint(row)}`);
        break;
      }

      case 'paragraph': {
        gap();
        // 源文本里的单个换行按**硬换行**处理（marked 的 breaks 语义）：模型经常逐行
        // 输出 ASCII 图、无标记列表、对齐片段，把它们合成一段再折行会毁掉版式。
        // 旧渲染器（wrap）也是保留换行的，这里必须一致。
        for (const lineSpans of block.lines) {
          for (const row of wrapSpans(lineSpans, inner)) out.push(`${lead}${paint(row)}`);
        }
        break;
      }

      case 'code': {
        gap();
        const gutter = `${lead}${styler.dim('| ')}`;
        const avail = Math.max(4, inner - 2);
        out.push(`${lead}${styler.dim(block.lang === '' ? '|' : `| ${block.lang}`)}`);
        const highlighter = options.highlighter?.(block.lang);
        for (const raw of block.lines) {
          const spans = highlighter ? highlighter.line(raw) : [{ text: raw }];
          const cut = clipSpans(spans, avail);
          // 超宽代码**裁剪而不折行**：折行会破坏可复制性。裁剪时留 4 列给省略标记。
          const body = cut.clipped ? clipSpans(spans, Math.max(0, avail - 4)).spans : cut.spans;
          out.push(`${gutter}${paint(body)}${cut.clipped ? styler.dim(' ...') : ''}`);
        }
        if (!block.closed) out.push(`${gutter}${styler.dim('...')}`);
        break;
      }

      case 'list': {
        gap();
        // 标记列宽**按深度**分别取最大值：同一层里 `9.` 与 `10.` 要对齐，但嵌套层的
        // `-` 不该被外层的 `1.` 撑宽（否则会出现 `  -  文本` 这种多余空格）。
        const fieldByDepth = new Map<number, number>();
        for (const item of block.items) {
          const current = fieldByDepth.get(item.depth) ?? 1;
          fieldByDepth.set(item.depth, Math.max(current, displayWidth(item.marker)));
        }
        for (const item of block.items) {
          const field = fieldByDepth.get(item.depth) ?? 1;
          const pad = '  '.repeat(item.depth);
          const markerPad = ' '.repeat(Math.max(0, field - displayWidth(item.marker)));
          const checkbox = item.task === undefined ? '' : item.task ? '[x] ' : '[ ] ';
          const head = `${lead}${pad}${styler.cyan(item.marker)}${markerPad} ${
            checkbox === '' ? '' : item.task ? styler.green(checkbox) : styler.dim(checkbox)
          }`;
          const headWidth = leadWidth + pad.length + field + 1 + displayWidth(checkbox);
          const hanging = ' '.repeat(headWidth);
          for (const [k, row] of wrapSpans(item.spans, Math.max(4, width - headWidth)).entries()) {
            out.push(`${k === 0 ? head : hanging}${paint(row)}`);
          }
        }
        break;
      }

      case 'quote': {
        gap();
        const bar = `${lead}${styler.dim('| ')}`;
        for (const lineSpans of block.lines) {
          const styled = lineSpans.map((s) => ({ ...s, tone: 'muted' as const }));
          for (const row of wrapSpans(styled, Math.max(4, inner - 2))) out.push(`${bar}${paint(row)}`);
        }
        break;
      }

      case 'rule': {
        gap();
        out.push(`${lead}${styler.dim('-'.repeat(Math.max(4, inner)))}`);
        break;
      }

      case 'table': {
        gap();
        out.push(...renderTable(
          block,
          width,
          lead,
          styler,
          options.tableOverflow ?? 'wrap',
          options.tableBorder ?? 'ascii',
        ));
        break;
      }
    }
    first = false;
  }

  // 链接目标统一在末尾列出：正文里塞 URL 会挤掉真正要读的内容（见 showLinks）。
  if (options.showLinks === true) {
    const links: string[] = [];
    for (const block of blocks) {
      collectLinks(block, links);
    }
    if (links.length > 0) {
      out.push('');
      for (const url of [...new Set(links)]) out.push(`${lead}${styler.dim(`[${url}]`)}`);
    }
  }

  return out;
}

function collectLinks(block: Block, out: string[]): void {
  const fromSpans = (spans: readonly Span[]): void => {
    for (const s of spans) if (s.link !== undefined) out.push(s.link);
  };
  switch (block.kind) {
    case 'heading':
      fromSpans(block.spans);
      break;
    case 'paragraph':
      for (const line of block.lines) fromSpans(line);
      break;
    case 'list':
      for (const item of block.items) fromSpans(item.spans);
      break;
    case 'quote':
      for (const line of block.lines) fromSpans(line);
      break;
    case 'table':
      for (const cell of block.header) fromSpans(cell);
      for (const row of block.rows) for (const cell of row) fromSpans(cell);
      break;
    default:
      break;
  }
}
