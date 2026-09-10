/**
 * 单行输入编辑器：纯函数，状态是「文本 + 光标（码点簇下标）」。
 *
 * 光标按码点簇而不是 UTF-16 下标移动——中文/emoji 下按 JS 下标移动会把一个字符拆开，
 * 渲染时出现半个字形。所有操作都返回新状态，便于脱离终端测试。
 */

import { clusters, displayWidth, sanitize } from './ansi.js';

export interface EditorState {
  text: string;
  /** 码点簇下标，取值 0..clusters(text).length。 */
  cursor: number;
}

export function emptyEditor(): EditorState {
  return { text: '', cursor: 0 };
}

export function editorClusters(state: EditorState): string[] {
  return clusters(state.text).map((cluster) => cluster.ch);
}

/** 用新文本替换内容，光标停在末尾（历史回溯用）。 */
export function setText(text: string): EditorState {
  const clean = sanitize(text).replace(/\n/g, ' ');
  return { text: clean, cursor: clusters(clean).length };
}

export function insertText(state: EditorState, inserted: string): EditorState {
  const clean = sanitize(inserted).replace(/\n/g, ' ');
  if (clean === '') return state;
  const parts = editorClusters(state);
  const added = clusters(clean).map((cluster) => cluster.ch);
  const at = clamp(state.cursor, 0, parts.length);
  parts.splice(at, 0, ...added);
  return { text: parts.join(''), cursor: at + added.length };
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

export function moveHome(state: EditorState): EditorState {
  return { ...state, cursor: 0 };
}

export function moveEnd(state: EditorState): EditorState {
  return { ...state, cursor: editorClusters(state).length };
}

export function moveWordLeft(state: EditorState): EditorState {
  const parts = editorClusters(state);
  let i = state.cursor;
  while (i > 0 && parts[i - 1] === ' ') i--;
  while (i > 0 && parts[i - 1] !== ' ') i--;
  return { ...state, cursor: i };
}

export function moveWordRight(state: EditorState): EditorState {
  const parts = editorClusters(state);
  let i = state.cursor;
  while (i < parts.length && parts[i] !== ' ') i++;
  while (i < parts.length && parts[i] === ' ') i++;
  return { ...state, cursor: i };
}

/** Ctrl+K：删除光标到行尾。 */
export function killToEnd(state: EditorState): EditorState {
  return { text: editorClusters(state).slice(0, state.cursor).join(''), cursor: state.cursor };
}

/** Ctrl+U：删除行首到光标。 */
export function killToStart(state: EditorState): EditorState {
  const parts = editorClusters(state);
  return { text: parts.slice(state.cursor).join(''), cursor: 0 };
}

/** Ctrl+W：删除光标前一个词。 */
export function killWordBefore(state: EditorState): EditorState {
  const parts = editorClusters(state);
  const target = moveWordLeft(state).cursor;
  parts.splice(target, state.cursor - target);
  return { text: parts.join(''), cursor: target };
}

/** 光标所在列（显示宽度），用于把终端光标放到输入行正确位置。 */
export function cursorColumn(state: EditorState): number {
  return displayWidth(editorClusters(state).slice(0, state.cursor).join(''));
}

/** 输入行可见性：文本过长时横向滚动，返回需要绘制的片段与光标在其中的列。 */
export function scrollEditor(state: EditorState, width: number): { segments: string[]; cursorColumn: number } {
  const limit = Math.max(1, width);
  const all = clusters(state.text);
  const cursor = clamp(state.cursor, 0, all.length);
  let relative = 0;
  for (let i = 0; i < cursor; i++) relative += all[i].width;

  // 光标越过右边界时右移视口，直到光标能落在可见区内（末列留给光标本身）。
  let start = 0;
  while (start < cursor && relative > limit - 1) {
    relative -= all[start].width;
    start++;
  }

  const visible: string[] = [];
  let used = 0;
  for (let i = start; i < all.length; i++) {
    if (used + all[i].width > limit) break;
    visible.push(all[i].ch);
    used += all[i].width;
  }
  return { segments: visible, cursorColumn: Math.min(relative, Math.max(0, limit - 1)) };
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}
