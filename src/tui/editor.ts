/**
 * 多行输入编辑器：纯函数，状态是「文本 + 光标（码点簇下标）」。
 *
 * 光标按码点簇而不是 UTF-16 下标移动——中文/emoji 下按 JS 下标移动会把一个字符拆开，
 * 渲染时出现半个字形。所有操作都返回新状态，便于脱离终端测试。
 *
 * 文本**允许换行**（对话框要高一些、宽敞一些，就要能写多行）：`\n` 是真实存在的一个
 * 码点簇，回车/粘贴都会产生它。折行只是渲染期的视觉行为（见 layoutLines），不落进
 * 状态里——否则 resize 时旧宽度的折痕会留下来。唯一的例外是软折行的边界：光标「上/
 * 下移一行」需要知道视觉行，因此 layout 的结果会参与 moveUp/moveDown 的计算。
 */

import { clusters, displayWidth, sanitize } from './ansi.js';

export interface EditorState {
  text: string;
  /** 码点簇下标，取值 0..clusters(text).length。 */
  cursor: number;
  /** 选区锚点（活跃端是 cursor）。undefined 表示没有选区。 */
  anchor?: number;
}

export function emptyEditor(): EditorState {
  return { text: '', cursor: 0 };
}

/**
 * 净化输入：去掉控制字符，但**保留换行**——多行输入要能真的换行。
 * 旧的 `replace(/\n/g,' ')` 把回车压成空格，多行因此不可能实现；
 * 「Enter 换行还是提交」由 app 按是否按了组合键决定。
 */
export function cleanInput(text: string): string {
  return sanitize(text);
}

export function editorClusters(state: EditorState): string[] {
  return clusters(state.text).map((cluster) => cluster.ch);
}

/** 用新文本替换内容，光标停在末尾（历史回溯用）。 */
export function setText(text: string): EditorState {
  const clean = cleanInput(text);
  return { text: clean, cursor: clusters(clean).length };
}

export function insertText(state: EditorState, inserted: string): EditorState {
  const clean = cleanInput(inserted);
  if (clean === '') return state;
  const parts = editorClusters(state);
  const added = clusters(clean).map((cluster) => cluster.ch);
  const at = clamp(state.cursor, 0, parts.length);
  parts.splice(at, 0, ...added);
  return { text: parts.join(''), cursor: at + added.length };
}

/** 换行：插入一个 `\n` 簇。多行输入靠它，而不是靠 Enter 提交。 */
export function newline(state: EditorState): EditorState {
  return insertText(state, '\n');
}

export function backspace(state: EditorState): EditorState {
  if (state.cursor <= 0) return state;
  const parts = editorClusters(state);
  parts.splice(state.cursor - 1, 1);
  return { text: parts.join(''), cursor: state.cursor - 1 };
}

export function deleteForward(state: EditorState): EditorState {
  const parts = editorClusters(state);
  if (state.cursor >= parts.length) return state;
  parts.splice(state.cursor, 1);
  return { text: parts.join(''), cursor: state.cursor };
}

export function moveLeft(state: EditorState): EditorState {
  return state.cursor <= 0 ? state : { ...state, cursor: state.cursor - 1 };
}

export function moveRight(state: EditorState): EditorState {
  const length = editorClusters(state).length;
  return state.cursor >= length ? state : { ...state, cursor: state.cursor + 1 };
}

/** 光标所在行的范围 [start, end)（不含换行符），end 即「行尾」。 */
export function lineRange(state: EditorState): { start: number; end: number } {
  const parts = editorClusters(state);
  const cursor = clamp(state.cursor, 0, parts.length);
  let start = cursor;
  while (start > 0 && parts[start - 1] !== '\n') start--;
  let end = cursor;
  while (end < parts.length && parts[end] !== '\n') end++;
  return { start, end };
}

export function moveHome(state: EditorState): EditorState {
  return { ...state, cursor: lineRange(state).start, anchor: undefined };
}

export function moveEnd(state: EditorState): EditorState {
  return { ...state, cursor: lineRange(state).end, anchor: undefined };
}

/** Ctrl+K：删除光标到行尾。 */
export function killToEnd(state: EditorState): EditorState {
  const parts = editorClusters(state);
  const { end } = lineRange(state);
  parts.splice(state.cursor, end - state.cursor);
  return { text: parts.join(''), cursor: state.cursor };
}

/** Ctrl+U：删除行首到光标。 */
export function killToStart(state: EditorState): EditorState {
  const parts = editorClusters(state);
  const { start } = lineRange(state);
  parts.splice(start, state.cursor - start);
  return { text: parts.join(''), cursor: start };
}

/** 光标前一个词的起点（跳过空白再跳过词本身）。词内不含换行，换行按空白处理。 */
export function moveWordLeft(state: EditorState): EditorState {
  const parts = editorClusters(state);
  const isSpace = (ch: string): boolean => ch === ' ' || ch === '\n';
  let i = clamp(state.cursor, 0, parts.length);
  while (i > 0 && isSpace(parts[i - 1])) i--;
  while (i > 0 && !isSpace(parts[i - 1])) i--;
  return { ...state, cursor: i, anchor: undefined };
}

/** 光标后一个词的起点（跳过词本身再跳过空白）。 */
export function moveWordRight(state: EditorState): EditorState {
  const parts = editorClusters(state);
  const isSpace = (ch: string): boolean => ch === ' ' || ch === '\n';
  let i = clamp(state.cursor, 0, parts.length);
  while (i < parts.length && !isSpace(parts[i])) i++;
  while (i < parts.length && isSpace(parts[i])) i++;
  return { ...state, cursor: i, anchor: undefined };
}

/** Ctrl+W：删除光标前一个词（可跨过换行，视为普通空白）。 */
export function killWordBefore(state: EditorState): EditorState {
  const parts = editorClusters(state);
  const target = moveWordLeft(state).cursor;
  parts.splice(target, state.cursor - target);
  return { text: parts.join(''), cursor: target };
}

/** 光标所在列（显示宽度），用于把终端光标放到输入行正确位置。 */
export function cursorColumn(state: EditorState): number {
  const parts = editorClusters(state);
  const { start } = lineRange(state);
  return displayWidth(parts.slice(start, state.cursor).join(''));
}

// ---------------------------------------------------------------- 视觉行布局

/**
 * 一段视觉行：`[start, end)` 是码点簇下标区间（换行符不属于任何段），`text` 是它的内容。
 *
 * 折行是**渲染期**行为：只按宽度算出来，从不写回 state。这样 resize 之后重新 layout
 * 就能得到新宽度的正确折行，而不是留着旧宽度的硬折痕。
 */
export interface EditorLine {
  start: number;
  end: number;
  text: string;
}

/**
 * 兼容旧接口的「单行可见性」：返回光标所在视觉行的内容与光标列。
 *
 * 保留它是为了让宽度/光标这类断言在单行场景下继续成立；多行渲染一律走 layoutLines。
 */
export function scrollEditor(state: EditorState, width: number): { segments: string[]; cursorColumn: number } {
  const limit = Math.max(1, width);
  const layout = layoutLines(state, limit);
  const index = lineIndexOf(layout, state.cursor);
  const line = layout[index];
  return { segments: [...line.text], cursorColumn: Math.min(offsetIn(line, state.cursor), Math.max(0, limit - 1)) };
}

/**
 * 硬换行优先、软折行兜底的布局。空段落保留一行（换行符前后各有一个「行」的位置）。
 *
 * **贪婪折行，与渲染层（markdown / 正文的折行）保持一致**：不为了把词留住而提前断行，
 * 因此屏幕上看到的内容不会被浏览器的「平衡折行」习惯带偏。
 *
 * 不变量：`line.end - line.start >= 2`（只要还有 2 个簇可放）。渲染层要取「行首前 2 簇」
 * 做标记探测，而中文里 2 个簇正好是「- 」这样的标记宽度；折行时把这两个簇留住，
 * 标记才不会在窄宽度下被截成半截。宽度小于 2 时放弃这个保证（`limit - 1` 会 ≤ 0）。
 */
export function layoutLines(state: EditorState, width: number): EditorLine[] {
  const limit = Math.max(1, width);
  const parts = editorClusters(state);
  const out: EditorLine[] = [];
  let start = 0;
  for (let i = 0; i <= parts.length; i++) {
    if (i === parts.length || parts[i] === '\n') {
      out.push(...foldLine(parts, start, i, limit));
      start = i + 1;
    }
  }
  return out.length > 0 ? out : [{ start: 0, end: 0, text: '' }];
}

function foldLine(parts: readonly string[], start: number, end: number, limit: number): EditorLine[] {
  const out: EditorLine[] = [];
  const floor = Math.max(1, limit - 1);
  let lineStart = start;
  let used = 0;
  for (let i = start; i < end; i++) {
    const width = displayWidth(parts[i]);
    // 放不下、且这一行已经攒够了最少簇数 → 在 i 处断行（i 归下一行）。
    if (used + width > limit && i - lineStart >= floor) {
      out.push({ start: lineStart, end: i, text: parts.slice(lineStart, i).join('') });
      lineStart = i;
      used = width;
      continue;
    }
    used += width;
  }
  out.push({ start: lineStart, end, text: parts.slice(lineStart, end).join('') });
  return out;
}

/** 簇下标在它所属视觉行内的列偏移（不越界夹取）。渲染层算光标列也要用它。 */
export function offsetIn(line: EditorLine, cluster: number): number {
  return displayWidth([...line.text].slice(0, cluster - line.start).join(''));
}

/**
 * 把「列」换算回该视觉行内的簇下标；列超过行宽时贴到行尾。
 *
 * 返回值**永远不会是换行符簇**：`line.end` 指向行尾字符之后，若那一簇恰好是 `\n`，
 * 光标落上去会让「上/下移」把它当成下一行的开头，从而一次跳两行。行尾统一收到
 * `line.end` 前一个可打印簇上（空行没有可打印簇，才退回 `line.start`）。
 */
function clusterAt(line: EditorLine, column: number): number {
  const chars = [...line.text];
  let used = 0;
  for (let i = 0; i < chars.length; i++) {
    const width = displayWidth(chars[i]);
    if (used + width > column) return line.start + i;
    used += width;
  }
  return chars.length === 0 ? line.start : line.start + chars.length - 1;
}

/**
 * `cluster` 落在第几个视觉行。
 *
 * 软折行边界上，一个簇同时是上一行的 `end` 与下一行的 `start`（折点处的那个字既在
 * 上一行末尾展示、又是下一行的第一个字）。这类位置**归到下一行**：光标实际停在那个
 * 字上，用户按「下」期望继续往下走，而不是原地不动。
 *
 * 硬换行的 `\n` 簇不在任何一行里（行的 `end` 指向 `\n` 之前），因此不会误判。
 */
export function lineIndexOf(lines: readonly EditorLine[], cluster: number): number {
  for (let i = 0; i < lines.length; i++) {
    if (cluster < lines[i].end) return i;
    // 落在行尾但该位置又是下一行行首（软折点）→ 归下一行。
    if (cluster === lines[i].end) {
      const next = lines[i + 1];
      return next !== undefined && next.start === cluster ? i + 1 : i;
    }
  }
  return Math.max(0, lines.length - 1);
}

/**
 * 上下移动：按**视觉行**而不是硬换行，且尽量保持列号（越过短行时贴到该行行尾）。
 *
 * 硬换行之间可以直接跳到隔壁行的同列；软折行必须先把「目标列」换算成视觉行内的位置，
 * 否则中文段落里按一下会跳掉半屏。
 *
 * 起点行直接用 lineIndexOf 的归属：光标停在行尾字符之后时它属于本行，按「下」正常
 * 走到下一行。clusterAt 保证落点不会是换行符，所以不存在「停在换行上」这种中间态。
 */
function moveByVisualLine(state: EditorState, width: number, delta: number): EditorState {
  const layout = layoutLines(state, width);
  const index = lineIndexOf(layout, state.cursor);
  const target = index + delta;
  if (target < 0 || target >= layout.length) return state;
  const column = offsetIn(layout[index], state.cursor);
  return { ...state, cursor: clusterAt(layout[target], column), anchor: undefined };
}

export function moveUp(state: EditorState, width: number): EditorState {
  return moveByVisualLine(state, width, -1);
}

export function moveDown(state: EditorState, width: number): EditorState {
  return moveByVisualLine(state, width, 1);
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}
