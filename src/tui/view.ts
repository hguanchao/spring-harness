/**
 * 纯渲染层：状态 → 屏幕行。没有任何 IO，也没有 TTY 依赖，可直接在测试里断言。
 *
 * 渲染模型是**整屏**：屏幕切成「上半部分 = 对话历史视口」+「底部 = 活动区（浮层 + 输入行
 * + 提示行 + notice + 状态行）」两段，整帧交给 terminal.paint 覆盖式绘制。历史视口由
 * composeFrame 按滚动偏移裁出，因此输入行永远钉在屏幕底部，位置不随内容多少跳动。
 *
 * 三条硬约定，改动时不要破：
 * 1. 每一行 displayWidth <= width。写满最后一列会触发终端自动换行，让整帧整体错位一行。
 *    折行一律由本模块负责（terminal.paint 里还有一道 clipLine 保险丝兜底）。
 * 2. 骨架字符只用 ASCII。东亚歧义宽度字符（·、…、↑↓、制表符）在部分终端按 2 列渲染，
 *    会让第 1 条失效——要表达方向键就写「上下键」，不要用箭头字形。
 * 3. 不做行尾补齐（菜单选中条除外）。整帧绘制时每行都从 ESC[2K 清行开始，短行不会留下
 *    上一帧的残尾；补齐只会给复制内容带上行尾空格。
 *
 * 色彩语义（16 色，落在终端自身调色板上，随浅色/深色主题自适应，不硬编码亮度）：
 *   cyan    用户输入前缀、可交互焦点、菜单标题
 *   yellow  需要你决策（审批 / 提问 / 计划三种浮层共用这一个色相，旧实现是三个任意色）
 *   magenta 只表示「计划模式」这一开关状态
 *   green   成功      red  失败 / 错误
 *   dim     只给元信息（耗时、计数、折叠体、提示行、状态行次要字段）
 *   inverse 选择态（终端里最标准的表达，不依赖色相，16 色下同样醒目）
 * 正文（助手回复、工具结果）一律用默认前景——旧实现把正文压成 dim，恰好压暗了要读的内容。
 */

import type { Styler } from './ansi.js';
import { displayWidth, inverseRange, pad, truncate, visibleSlice, wrap } from './ansi.js';
import { cursorColumn, type EditorLine, layoutLines, lineIndexOf, offsetIn } from './editor.js';
import { createHighlighter } from './highlight.js';
import { renderMarkdown } from './markdown.js';
import { CHOICE_GAP, renderDialog, type DialogChoice, type DialogLine } from './dialog.js';
import type { ApprovalPrompt, FormPrompt, NoticeLevel, Selection, TranscriptEntry, TuiState } from './state.js';
import { cacheHitRate } from './state.js';
import { formatDuration, renderToolDetail, summarizeToolCall, summarizeToolRun, toolTone, type ToolCallView } from './tool-view.js';

export interface ViewOptions {
  width: number;
  height: number;
  styler: Styler;
  /** 当前时间，仅用于运行中指示的「已耗时」；测试可注入固定值。 */
  now?: number;
}

export interface LiveView {
  lines: string[];
  /** 终端光标位置（相对活动区首行）；null 表示隐藏光标。 */
  cursor: { row: number; col: number } | null;
}

const SPINNER = ['|', '/', '-', '\\'];
const SEPARATOR = ' | ';
/** 该优先级及以上的段不参与降级丢弃：实时指示必须始终可见。 */
const PINNED = 9;

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/** 占用条：纯 ASCII（`#`/`-`）。块字符 U+2588 属歧义宽度，不能用。 */
export function progressBar(ratio: number, width: number): string {
  const limit = Math.max(3, Math.floor(width));
  const clamped = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
  // 非零占用至少点亮一格：否则 0.5% 的上下文压力看起来和「没调用过模型」一样。
  const filled = clamped === 0 ? 0 : Math.max(1, Math.round(clamped * limit));
  return `[${'#'.repeat(filled)}${'-'.repeat(limit - filled)}]`;
}

/**
 * 状态行前缀图标。
 *
 * 只用「单码点、默认 emoji 呈现」的字符，且必须落在 ansi.ts 的宽字符表内（这几个都在
 * 1F300-1F64F / 1F900-1F9FF，charWidth 算 2 列）。刻意避开两类字符：
 * - 需要 U+FE0F 变体选择符才呈 emoji 的（如 ⚡ 26A1）：终端按 2 列渲染而 charWidth 按 1 列算；
 * - ZWJ 组合序列（如 👨‍💻）：clusters() 会把 ZWJ 之后的部分算成独立簇，宽度多算 2 列。
 */
const ICON = {
  project: '📁',
  branch: '🌿',
  model: '🤖',
  effort: '🧠',
  context: '🧮',
  cache: '🔁',
  ask: '🔒',
  auto: '🔐',
  yolo: '🔓',
} as const;

function permissionIcon(mode: string): string {
  if (mode === 'yolo') return ICON.yolo;
  if (mode === 'auto') return ICON.auto;
  return ICON.ask;
}

// ---------------------------------------------------------------- 状态行

interface Segment {
  text: string;
  paint: (text: string) => string;
  /** 数字越大越先保留。 */
  priority: number;
}

/**
 * 分段合成单行：超出宽度时按优先级丢段，而不是截断。
 * 截断会把带色文本结尾的复位序列切掉、让颜色泄漏；丢段则完全避开这个问题——
 * 每一段都是「纯文本 + 单一着色函数」，永远不会被切。窄终端下自然退化成只留关键字段。
 */
function composeSegments(segments: readonly Segment[], width: number, styler: Styler): string {
  let kept = segments.filter((segment) => segment.text !== '');
  const measure = (list: readonly Segment[]): number =>
    list.reduce((total, segment) => total + displayWidth(segment.text), 0) +
    Math.max(0, list.length - 1) * SEPARATOR.length;

  while (measure(kept) > width) {
    let worstIndex = -1;
    let worstPriority = Number.POSITIVE_INFINITY;
    for (let i = 0; i < kept.length; i++) {
      if (kept[i].priority >= PINNED) continue;
      // <= 让同优先级里最靠右的先被丢掉
      if (kept[i].priority <= worstPriority) {
        worstPriority = kept[i].priority;
        worstIndex = i;
      }
    }
    if (worstIndex < 0) break;
    kept.splice(worstIndex, 1);
  }
  if (kept.length === 0) return '';

  // 只剩固定段仍超宽（极窄终端）：只截断最后一段的纯文本。
  if (measure(kept) > width) {
    const last = kept[kept.length - 1];
    const budget = width - (measure(kept) - displayWidth(last.text));
    kept = [...kept.slice(0, -1), { ...last, text: truncate(last.text, Math.max(0, budget)) }];
  }
  return kept.map((segment) => segment.paint(segment.text)).join(styler.dim(SEPARATOR));
}

function approvalTone(mode: string, styler: Styler): (text: string) => string {
  if (mode === 'yolo') return (text) => styler.red(text); // 全部放行，属危险态
  if (mode === 'auto') return (text) => styler.cyan(text);
  return (text) => styler.yellow(text); // ask：迟早会来问你
}

function sandboxTone(mode: string, styler: Styler): (text: string) => string {
  return mode === 'off' ? (text) => styler.red(text) : (text) => styler.cyan(text);
}

function pressureTone(ratio: number, styler: Styler): (text: string) => string {
  if (ratio >= 0.9) return (text) => styler.red(text);
  if (ratio >= 0.7) return (text) => styler.yellow(text);
  return (text) => styler.cyan(text);
}

/**
 * 状态行字段（按用户指定的顺序与形态：`| <emoji> 值 | ... |`）：
 *   模型 | 推理等级 | 上下文 | 缓存命中率 | 权限模式
 * 运行中的实时指示作为前缀（只在跑的时候出现），PLAN 追加在末尾（计划模式会改变可用工具，
 * 不能让它在窄终端里被静默丢掉，因此给了较高的保留优先级）。
 */
function statusSegments(state: TuiState, styler: Styler, now: number): Segment[] {
  const segments: Segment[] = [];
  if (state.phase === 'running') {
    const active = state.activeTool;
    if (active) {
      // 只留「工具名 + 已耗时」：耗时每秒在跳，本身就是活动指示，不需要再占一个帧字符。
      // 状态行要同时放下 7 个字段，这里的每一列都影响「缓存命中率」会不会被挤掉。
      const elapsed = Math.max(0, now - active.startedAt);
      segments.push({
        text: `${active.name}${elapsed >= 1000 ? ` ${formatDuration(elapsed)}` : ''}`,
        paint: (value) => styler.cyan(value),
        priority: PINNED,
      });
    } else {
      segments.push({
        text: SPINNER[state.spinner % SPINNER.length],
        paint: (value) => styler.cyan(value),
        priority: PINNED,
      });
    }
  }

  segments.push({ text: `${ICON.model} ${state.model}`, paint: (v) => styler.bold(v), priority: 8 });
  segments.push({ text: `${ICON.effort} ${state.effort ?? 'off'}`, paint: (v) => styler.dim(v), priority: 5 });

  if (state.usage.lastPrompt > 0 && state.contextWindow > 0) {
    const ratio = state.usage.lastPrompt / state.contextWindow;
    segments.push({
      text: `${ICON.context} ${progressBar(ratio, 4)} ${Math.round(ratio * 100)}%`,
      paint: pressureTone(ratio, styler),
      priority: 6,
    });
  }
  const hit = cacheHitRate(state.usage);
  if (hit !== undefined) {
    segments.push({
      text: `${ICON.cache} ${Math.round(hit * 100)}%`,
      paint: hit >= 0.5 ? (v) => styler.green(v) : (v) => styler.dim(v),
      priority: 4,
    });
  }
  segments.push({
    text: `${permissionIcon(state.approvalMode)} ${state.approvalMode}`,
    paint: approvalTone(state.approvalMode, styler),
    // 权限格钉住：它决定工具会不会不经询问就跑，任何宽度下都不许被降级丢掉。
    priority: PINNED,
  });

  // 唯一破例的两个附加格：计划模式会改可用工具、沙箱 off 等于没有隔离，都属于
  // 「不说出来就可能误判」的状态，不能因为窄终端被静默丢掉（沙箱也仍在 /status 与横幅里）。
  if (state.planMode) segments.push({ text: 'PLAN', paint: (v) => styler.magenta(v), priority: 7 });
  if (state.sandboxMode === 'off') segments.push({ text: 'sandbox off', paint: (v) => styler.red(v), priority: 7 });

  if (state.todo.total > 0) {
    const allDone = state.todo.done === state.todo.total;
    segments.push({
      text: `todo ${state.todo.done}/${state.todo.total}`,
      paint: allDone ? (v) => styler.green(v) : (v) => styler.cyan(v),
      priority: 3,
    });
  }
  if (state.jobs > 0) {
    segments.push({ text: `jobs ${state.jobs}`, paint: (v) => styler.yellow(v), priority: 2 });
  }

  // 操作消息（命令反馈、错误）放在状态行**最右**，优先级压过一切普通格：它是刚刚发生的
  // 事，用户此刻正等着看它，被挤掉就等于命令没反馈。它不替代状态行，只是搭一段车。
  // 目前它由 app 在几秒后自动清掉；没清的时候也一直可见。
  if (state.notice) {
    segments.push({
      text: `${noticeMark(state.notice.level)} ${state.notice.text}`,
      paint: noticePaint(state.notice.level, styler),
      priority: PINNED + 1,
    });
  }
  return segments;
}

// ---------------------------------------------------------------- 垂直布局规格

/**
 * 垂直布局：屏幕按「行」切成四个固定区域，自上而下依次是
 *
 *   ┌── 行 0 .. H-1 ─────────────────────────────────────────────┐
 *   │ 区域 1  标题栏    固定 1 行   永不压缩                      │
 *   │ 区域 2  对话流    弹性，吃掉全部剩余（视口）                │
 *   │ 区域 3  输入区    固定 INPUT_ROWS 行                        │
 *   │ 区域 4  状态栏    固定 1 行   永不压缩                      │
 *   └────────────────────────────────────────────────────────────┘
 *
 * 对应到 HTML 盒模型：都是一个 `width:100%` 的块级 div；标题栏与状态栏是固定高度，
 * 对话流是 `flex:1`（`overflow:hidden`，靠内部 scroll 偏移取一窗）。差别只在于终端
 * 没有「行高」概念，高度必须取整数行、且不能靠内容撑开——所以这里全部是**行数分配**，
 * 而不是 CSS 那样的内容驱动。
 *
 * 弹性区的行数就是 `H - 2 - INPUT_ROWS`。它靠「剩余」定义，所以窗口变高时全部涨在
 * 对话流上，变矮时也只从对话流里扣——**四个区域的位置顺序与两个固定区的高度都与 H 无关**。
 */
export const HEADER_ROWS = 1;
export const FOOTER_ROWS = 1;
/** 输入区正文行数。正文固定 1 行，外层另加上下边框。 */
export const INPUT_ROWS = 1;
const INPUT_BORDER_ROWS = 2;
const INPUT_FRAME_ROWS = INPUT_ROWS + INPUT_BORDER_ROWS;

/**
 * 最矮可用高度：3 个固定行（标题 + 输入区 1 行 + 状态栏）刚好铺满一屏，对话流退化为 0 行。
 *
 * 高度不足时**按优先级丢整块**（规则由丢得最早的排在最前）：
 *
 *   1. 对话流   —— 最先牺牲，它只是「看不到历史」，界面仍然可读；
 *   2. 标题栏   —— 其次是标识信息；
 *   3. 输入区   —— 再其次是编辑能力（此时对话流已回来，改为只读回看）；
 *   4. 状态栏   —— 最后才丢；只要还剩 1 行，那 1 行一定是状态栏。
 *
 * 取舍逻辑是「保住输入与当前状态」：状态栏承载权限模式等安全相关字段（见状态行的
 * PINNED 段），输入区是用户唯一的入口。两者同时放不下时保状态栏——只读界面比一个
 * 不知道自己处于什么权限模式的可写界面更安全。
 */
const LAYOUT_MIN_HEIGHT = HEADER_ROWS + INPUT_FRAME_ROWS + FOOTER_ROWS;

/** 四个区域的垂直分配结果；每项都是行数，`0` 表示该区域在极高/极矮时被让出或被丢弃。 */
export interface LayoutRegions {
  header: number;
  /** 输入区**正文**行数。 */
  composer: number;
  footer: number;
  /** 对话流视口行数 = 一屏 - 三个固定区（至少 1，保证不会整屏只剩输入框）。 */
  body: number;
}

/**
 * 把一屏高度分配给四个区域。
 *
 * 返回值保证 `header + body + composer(正文) + footer >= height` 中的**固定区之和**永远
 * 不超过 height —— 这是「绝不画到屏幕外」的不变量，由 composeFrame 的最终夹紧兜底。
 */
export function layoutRegions(height: number): LayoutRegions {
  const h = Math.max(1, Math.floor(height));
  if (h >= LAYOUT_MIN_HEIGHT) {
    return {
      header: HEADER_ROWS,
      composer: INPUT_ROWS,
      footer: FOOTER_ROWS,
      // 至少 1 行：即使 H 刚好等于 LAYOUT_MIN_HEIGHT，也给历史留一条缝，
      // 否则用户会以为界面卡死了（与 renderLive 的 maxRows 下限同一考虑）。
      body: Math.max(1, h - HEADER_ROWS - INPUT_FRAME_ROWS - FOOTER_ROWS),
    };
  }
  if (h >= 3) {
    // 输入区被压到 1 行（只够一行输入，垂直居中退化为「没有居中可言」）。
    return { header: HEADER_ROWS, composer: 1, footer: FOOTER_ROWS, body: Math.max(1, h - 3) };
  }
  if (h === 2) return { header: 0, composer: 1, footer: FOOTER_ROWS, body: 1 };
  return { header: 0, composer: 0, footer: FOOTER_ROWS, body: 0 };
}

// ---------------------------------------------------------------- 活动区

/**
 * 对话框该显示几行。
 *
 * 长度取「期望高度」与「本帧实际放得下的高度」的较小值——对话框是**固定高度**的弹窗，
 * 内容少时下方补空行、内容多时滚动跟随光标，「高度更宽敞」指的正是这个固定高度，
 * 而不是跟着内容一会儿三行一会儿一行地跳。
 *
 * 可用空间必须参与计算：浮层是按「固定 + 对话框行数」自算高的，它并不知道活动区还有
 * maxRows 这道硬上限；窄屏 + 大段落时对话框会把浮层整块顶出屏幕。这里是唯一知道全部
 * 已用行数的地方，所以这道闸放在这里。
 *
 * 返回 0 表示这一帧连一行都放不下（极窄屏 + 大浮层），调用方应整块略过对话框。
 */
function rowsForComposer(wanted: number, height: number, usedRows: number): number {
  return Math.min(wanted, Math.max(0, height - 1 - usedRows - INPUT_BORDER_ROWS - 2));
}

/**
 * 输入框正文行：内容行 + 补足到 rows 的空行，外层统一绘制上下边框，背景铺满整宽
 * 形成一条浅灰色带。
 *
 * 补空行是必须的：`all` 只有实际存在的视觉行，直接把 `all.slice(...)` 铺出来的框会
 * 比当前内容还矮，「固定高度」就退化成「高度跟着内容跳」——空输入时只有一行，
 * 用户看到的还是那个窄条。
 */
function composerRows(
  lines: readonly EditorLine[],
  rows: number,
  width: number,
): string[] {
  const lineWidth = Math.max(1, width - 1);
  const border = '─'.repeat(lineWidth);
  // 内容不足整框时垂直居中；单行输入通常会落在唯一正文行。
  const offset = lines.length >= rows ? 0 : Math.floor((rows - lines.length) / 2);
  const body = Array.from({ length: rows }, (_, i) => {
    const line = lines[i - offset];
    return pad(truncate(line?.text ?? '', lineWidth, ''), lineWidth);
  });
  return [border, ...body, border];
}

/**
 * 活动区渲染：浮层（若有）+ 对话框 + notice + 状态行。
 *
 * 提示行（Enter 发送 / PgUp 回看 ……）已经去掉，键位说明留给 `/help`，底部只保留状态行
 * ——状态行是不该被挤掉的常驻信息，键位不是。
 */
export function renderLive(state: TuiState, options: ViewOptions): LiveView {
  const { width, styler } = options;
  const now = options.now ?? Date.now();
  /** 浮层候选列表的高度：与对话框无关的固定上限，菜单不会因为输入框变高而被压成一条。 */
  const budget = Math.max(4, Math.min(12, options.height - 10));
  const lines: string[] = [];
  let cursor: { row: number; col: number } | undefined;

  /**
   * 把对话框钉在当前活动区末尾。rows 由调用方按剩余空间算好（含补足的空行）。
   *
   * 内容比 rows 多时取「以光标为中心」的一段窗口，让正在敲的那一行始终可见；
   * 光标行号随之在框内移动，终端光标才不会跳到框外。
   */
  const pushComposer = (editor: TuiState['editor'], rows: number): void => {
    if (rows <= 0) return;
    const all = layoutLines(editor, Math.max(1, width - 1));
    const cursorLine = lineIndexOf(all, editor.cursor);
    const start = Math.max(0, Math.min(cursorLine - rows + 1, all.length - rows));
    const shown = start <= 0 ? all.slice(0, rows) : all.slice(start, start + rows);
    const shownCursorLine = cursorLine - start;
    const column = offsetIn(shown[Math.min(shownCursorLine, shown.length - 1)], editor.cursor);
    // 行号要跟着 composerRows 的居中偏移走，否则光标会落在「内容实际所在行」之外的
    // 那一行（居中时内容不在框顶）。
    const centering = shown.length >= rows ? 0 : Math.floor((rows - shown.length) / 2);
    lines.push(...composerRows(shown, rows, width));
    cursor = {
      row: lines.length - rows - INPUT_BORDER_ROWS + 1 + centering + shownCursorLine,
      col: Math.min(column, Math.max(0, width - 2)),
    };
  };

  const prompt = state.prompt;
  // 输入区正文固定 1 行（不随窗口高度增长），菜单 / 计划浮层与空闲态共用同一份——
  // 只在空闲态调高、一进菜单又缩回去会很跳。
  const composerRowsWanted = INPUT_ROWS;
  const rowsAllowed = (used: number): number => rowsForComposer(composerRowsWanted, options.height, used);

  /**
   * 浮层和对话框一起钉在底部，所以对话框最多只能长到「窗口高度 - 浮层行数 - 状态行」。
   * 不夹这一刀的话，浮层 + 对话框会超出屏幕，Activity 的 maxRows 再裁掉浮层顶部——
   * 看起来就是「菜单标题莫名其妙消失了」。
   */
  const pushBelowPanel = (editor: TuiState['editor'], panelRows: number): void => {
    const room = options.height - 1 - panelRows - 1 - INPUT_BORDER_ROWS;
    pushComposer(editor, Math.max(1, Math.min(rowsAllowed(panelRows), room)));
  };

  if (prompt?.kind === 'approval') {
    lines.push(...approvalPanel(prompt, width, styler));
  } else if (prompt?.kind === 'ask') {
    const panel = askPanel(prompt.question, width, styler);
    lines.push(...panel);
    pushBelowPanel(prompt.editor, panel.length);
  } else if (prompt?.kind === 'plan') {
    const panel = planPanel(prompt.plan, width, budget, styler);
    lines.push(...panel);
    pushBelowPanel(prompt.editor, panel.length);
  } else if (prompt?.kind === 'form') {
    // 表单自带输入区，不再挂主输入行：两个输入框叠在同一个输入框之上，光标该落哪就说不清了。
    const panel = formPanel(prompt, width, styler);
    const base = lines.length;
    lines.push(...panel.lines);
    if (panel.cursor) cursor = { row: base + panel.cursor.row, col: panel.cursor.col };
  } else if (state.phase === 'menu' && state.menu) {
    const panel = menuPanel(state.menu, width, budget, styler);
    lines.push(...panel);
    pushBelowPanel(state.editor, panel.length);
  } else if (state.phase === 'status') {
    lines.push(...statusPanel(state, width, styler));
  } else {
    pushComposer(state.editor, rowsAllowed(0));
  }

  // 状态行必须排在最后，它永远是整屏的最后一行。
  // 操作消息（notice）也只在这里显示，避免回看时重复占用一行。
  lines.push(composeSegments(statusSegments(state, styler, now), width, styler));

  // 活动区硬上限：标题栏 + 输入区 + 状态栏各占至少 1 行，剩下的才是对话流；而对话流
  // 至少留 1 行，否则整屏只剩输入框，看起来像卡死了。
  //
  // 裁掉的都是活动区**顶部**（浮层标题 / 候选列表）——输入区与状态栏钉在底部不会被裁到，
  // 因此光标行号只需要跟着整体上移。
  const maxRows = Math.max(LAYOUT_MIN_HEIGHT, options.height - 1);
  if (lines.length > maxRows) {
    const drop = lines.length - maxRows;
    lines.splice(0, drop);
    cursor = cursor === undefined ? undefined : { row: Math.max(0, cursor.row - drop), col: cursor.col };
  }
  return { lines, cursor: cursor ?? null };
}

// ---------------------------------------------------------------- 整帧

/**
 * 四个区域的行数分配（composeFrame 与 app 的滚动夹紧共用同一份算术）。
 *
 * 固定区是「标题栏 1 + 输入区正文 + 状态栏 1」，其余全给对话流。
 * 输入区的正文行数已由 renderLive 按剩余空间夹过一次，这里直接采信它给出的实际行数
 * ——所以 G 是**已经算好的一屏内实数**，不再是名义上的 INPUT_ROWS。
 *
 * 高度不足时按 layoutRegions 的优先级丢弃整块（对话流最先，状态栏最后）。
 */
export interface FramePlan {
  /** 标题栏行数（0 = 该区域被丢弃）。 */
  header: number;
  /** 对话流视口行数。 */
  body: number;
  composer: number;
  /** 状态栏行数（0 = 该区域被丢弃）。 */
  footer: number;
}

/**
 * 对话流在**最终帧**里占的行区间（0 基，闭开区间 `[top, top + rows)`）。
 *
 * 与 `FramePlan.body` 不是一回事：后者是名义分配，不含浮层挤压；这里量的是屏幕上
 * 真正的那片区域，供滚轮命中判断使用。活动区（浮层 + 输入区 + 状态栏）钉在最底部，
 * 对话流就是「标题栏之后、活动区之前」那一段——浮层盖住的行不该再响应滚轮。
 */
export interface BodyRegion {
  top: number;
  rows: number;
  /**
   * 正文**内容**第一行落在屏幕的哪一行（跳过头栏、吸顶的用户消息、顶部补白）。
   *
   * 与 top/rows 是两个不同的区间，刻意不合并：top/rows 是「滚轮可以作用的范围」，含正文前后的
   * 补白（悬在补白上也该能滚）；contentTop/contentRows 是「真的画着正文的哪几行」，
   * 鼠标选区只认后者——点在补白上不该选中任何东西。
   */
  contentTop: number;
  /** 正文第一行在 body 数组里的下标，配合 contentTop 把屏幕行换算成内容坐标。 */
  contentIndex: number;
  /** 正文内容可见的行数。 */
  contentRows: number;
}

/** 对话流中可双击展开的工具块逻辑区间。 */
export interface ToolBlockRegion {
  start: number;
  end: number;
  id: string;
}

/** 最终屏幕中的工具块区间，坐标为 0 基闭开区间。 */
export interface ScreenToolBlockRegion {
  top: number;
  bottom: number;
  id: string;
}

/** 对话流中的用户消息区间，用于滚动时把已离开视口的消息固定到顶部。 */
export interface UserPromptRegion {
  start: number;
  end: number;
  lines: readonly string[];
}

interface StickyPrompt {
  lines: readonly string[];
  contentRows: number;
}

/**
 * 找到当前滚动位置对应的用户消息吸顶内容。
 *
 * 用户消息作为当前对话段的标题：当消息顶部已经越过普通视口顶部时吸顶，
 * 最多保留 3 行，避免一条很长的输入把助手内容挤没。
 */
function stickyPromptFor(
  bodyLength: number,
  bodyRows: number,
  scroll: number,
  prompts: readonly UserPromptRegion[],
): StickyPrompt | undefined {
  // `scroll=0` 表示跟随最新内容（视口在历史底部），并不等于时间线顶部；
  // 只要用户消息已经位于该视口上方，它在底部跟随时同样应该吸顶。
  if (bodyRows <= 0 || prompts.length === 0) return undefined;
  const end = Math.max(0, Math.min(bodyLength, bodyLength - Math.floor(scroll)));
  const viewportTop = Math.max(0, end - bodyRows);
  // 下一条用户消息恰好落在内容区第一行时，它接管顶部；不能继续显示上一条吸顶消息，
  // 否则“发送后翻页”会把最新用户消息吞掉，只剩回复正文。
  if (prompts.some((candidate) => candidate.start === viewportTop)) return undefined;
  const prompt = [...prompts].reverse().find((candidate) => candidate.start < viewportTop);
  if (!prompt || prompt.lines.length === 0) return undefined;

  const stickyRows = Math.min(3, prompt.lines.length, bodyRows);
  return {
    lines: prompt.lines.slice(0, stickyRows),
    contentRows: Math.max(0, bodyRows - stickyRows),
  };
}

export function planFrame(height: number, live: LiveView): FramePlan {
  const h = Math.max(1, Math.floor(height));
  const layout = layoutRegions(h);
  const total = live.lines.length;
  // 状态栏是 live 的最后一行（renderLive 保证它最后 push）。
  const footer = layout.footer === 0 ? 0 : Math.min(1, total);

  /**
   * 输入区正文**从 live 末尾往上量**，不能按 live 总行数反推。
   *
   * renderLive 的 lines 里除了「输入区 + 状态栏」，前面还可能压着一整块浮层
   * （菜单 / 审批 / 提问 / 计划）。按总行数减出来会把浮层行也算进输入区，于是 composer
   * 被撑大、body 被挤到 1 行，整块浮层失去可用空间被裁掉——现象是「菜单标题莫名其妙
   * 消失」。renderLive 的 pushComposer 已经按 rowsForComposer 把实际行数夹好了，
   * 这里只负责按同样的 3 行定位，名义值与实际值在极端高度下的差异由 MAX 兜住。
  */
  const composerFrameRows = layout.composer > 0 ? layout.composer + INPUT_BORDER_ROWS : 0;
  const requested = Math.min(composerFrameRows, Math.max(0, total - footer));
  const composer = requested === 0 ? 0 : Math.min(requested, Math.max(0, h - footer - layout.header - 1));

  const header = layout.header === 0 || composer + footer + 1 > h ? 0 : layout.header;
  // 对话流吃掉剩下的一切，且至少 1 行——否则整屏只有框、看不到历史。
  const body = Math.max(1, h - header - composer - footer);
  return { header, body, composer, footer };
}

/**
 * 把四个区域组装成**正好一屏**的整帧。
 *
 * 垂直顺序自上而下固定：标题栏 → 对话流视口 → 输入区 → 状态栏。
 * 中间那个区靠 `flex` 吃掉剩余行数，所以窗口变高只长对话流，变矮也只从对话流里扣。
 *
 * 对话流在内容溢出时底部对齐：scroll=0 时最新内容紧贴输入区上方；scroll 越大越往早前看。
 * 历史不足一屏时从视口顶部开始排布，剩余空间补在内容下方，避免初始对话看起来从底部出现。
 *
 * 调用方负责把 scroll 夹到有效范围内（见 app 的 maxScroll 计算），这里只做防御性收敛。
 */
export function composeFrame(
  header: string,
  body: readonly string[],
  live: LiveView,
  options: ViewOptions,
  scroll: number,
  state: TuiState,
  userPrompts: readonly UserPromptRegion[] = [],
  toolBlocks: readonly ToolBlockRegion[] = [],
): LiveView & { plan: FramePlan; body: BodyRegion; toolBlocks: ScreenToolBlockRegion[] } {
  const height = Math.max(1, options.height);
  const plan = planFrame(height, live);

  // 活动区（浮层 + 输入区 + 状态栏）整体钉在屏幕底部，所以从 live 末尾往上取
  // 一整段，而不是只取「输入区 + 状态栏」那几行——浮层压在它们上面，同样要画出屏幕。
  //
  // 浮层可以高到超出对话流剩余的空间，此时从**顶部**裁掉浮层的靠上部分（菜单标题最倒霉，
  // 与旧行为一致），输入区与状态栏永远保住。
  const activityBudget = Math.max(0, height - plan.header);
  const activity = live.lines.slice(Math.max(0, live.lines.length - activityBudget));
  // 夹紧后活动区可能仍高于可用空间（极矮屏 + 大浮层）：继续从顶部裁。
  if (activity.length > activityBudget) activity.splice(0, activity.length - activityBudget);
  const dropped = Math.max(0, live.lines.length - activity.length - Math.max(0, plan.body - 0));

  const offset = Math.max(0, Math.floor(scroll));
  const end = Math.max(0, Math.min(body.length, body.length - offset));
  const sticky = stickyPromptFor(body.length, plan.body, offset, userPrompts);
  const contentRows = sticky?.contentRows ?? plan.body;
  const fitsAtTop = offset === 0 && body.length <= contentRows;
  const start = fitsAtTop ? 0 : Math.max(0, end - contentRows);
  const visibleRows = end - start;
  const blank = fitsAtTop ? 0 : Math.max(0, contentRows - visibleRows);
  const trailingBlank = fitsAtTop ? Math.max(0, contentRows - visibleRows) : 0;
  const stickyRows = sticky?.lines.length ?? 0;

  const lines = [
    ...(plan.header > 0 ? [header] : []),
    ...(sticky?.lines ?? []),
    ...new Array<string>(blank).fill(''),
    ...body.slice(start, end),
    ...new Array<string>(trailingBlank).fill(''),
    ...activity,
  ];

  const toolRegionsBeforeClamp = toolBlocks.flatMap((region): ScreenToolBlockRegion[] => {
    const visibleStart = Math.max(region.start, start);
    const visibleEnd = Math.min(region.end, end);
    if (visibleStart >= visibleEnd) return [];
    return [{
      top: plan.header + stickyRows + blank + visibleStart - start,
      bottom: plan.header + stickyRows + blank + visibleEnd - start,
      id: region.id,
    }];
  });

  // 防御：固定区之和理论上总在屏幕内，但 renderLive 的裁切与这里的分配是两处算术，
  // 万一不一致就会把状态栏挤出屏幕——最后一道夹紧放在这里，宁可让顶部内容丢掉。
  const droppedTop = Math.max(0, lines.length - height);
  if (droppedTop > 0) lines.splice(0, droppedTop);
  while (lines.length < height) lines.push('');

  const cursorRow = plan.header + stickyRows + blank + (end - start) + trailingBlank + (live.cursor ? live.cursor.row - dropped : 0);
  const cursor = live.cursor && live.cursor.row - dropped >= 0
    ? { row: cursorRow, col: live.cursor.col }
    : null;
  // plan 一并交回：调用方（滚轮命中判断）需要知道对话流到底占了哪几行，
  // 自己再算一遍就会和这里的分配漂移。
  //
  // body 区间按**最终 lines** 量：活动区（浮层 + 输入区 + 状态栏）钉在最底部，
  // 对话流就是「标题栏之后、活动区之前」那一段。有浮层时活动区变高，对话流随之变矮，
  // 这正是我们想要的——浮层盖住的那几行不该再响应滚轮。
  const bodyTop = Math.min(plan.header, height);
  const bodyRows = Math.max(0, height - bodyTop - activity.length);
  // 正文内容的真实屏幕区间：头栏之后、吸顶用户消息与顶部补白之后的第一行正文，
  // 连续 visibleRows 行。droppedTop 是最后那道顶部夹紧，会让整体上移。
  const contentTop = Math.max(0, plan.header + stickyRows + blank - droppedTop);
  const bodyContentRows = Math.max(0, Math.min(visibleRows, height - contentTop));
  // 选区高亮放在**最后**：此时行已经定稿（补空、夹紧都做完了），行号就是屏幕行号，
  // 于是「内容坐标 → 屏幕行」的换算可以直接用上面这份映射。
  applySelection(lines, state.selection, contentTop, start, bodyContentRows);
  const toolRegions = toolRegionsBeforeClamp.flatMap((region): ScreenToolBlockRegion[] => {
    const top = region.top - droppedTop;
    const bottom = region.bottom - droppedTop;
    if (bottom <= 0 || top >= height) return [];
    return [{ top: Math.max(0, top), bottom: Math.min(height, bottom), id: region.id }];
  });
  return {
    lines,
    cursor,
    plan,
    body: {
      top: bodyTop,
      rows: bodyRows,
      contentTop,
      contentIndex: start,
      contentRows,
    },
    toolBlocks: toolRegions,
  };
}

/**
 * 选中区间按 `anchor → head` 归一化后逐行反显。
 *
 * 区间是「闭」的（两端字符都算选中），这是所有终端选区的惯例：拖到第 5 列松手，
 * 第 5 列那个字符应该被选中。因此末行的结束列要 +1 才对得上。
 *
 * 选区存的是**内容坐标**，这里只做一次换算：屏幕行 = `contentTop + (内容行 - contentIndex)`。
 * 落在可见区间之外的内容行直接跳过——它会随着滚动进入/离开视口，不需要额外记账。
 */
function applySelection(
  lines: string[],
  selection: Selection | undefined,
  contentTop: number,
  contentIndex: number,
  contentRows: number,
): void {
  if (!selection) return;
  const { anchor, head } = selection;
  const reversed = anchor.row > head.row || (anchor.row === head.row && anchor.col > head.col);
  const first = reversed ? head : anchor;
  const last = reversed ? anchor : head;
  for (let row = first.row; row <= last.row; row++) {
    const screenRow = contentTop + (row - contentIndex);
    if (row < contentIndex || row >= contentIndex + contentRows) continue;
    if (screenRow < 0 || screenRow >= lines.length) continue;
    const startCol = row === first.row ? first.col : 0;
    // 中间行整行选中：给一个足够大的上界，inverseRange 自己会在行尾停下。
    const endCol = row === last.row ? last.col + 1 : Number.MAX_SAFE_INTEGER;
    lines[screenRow] = inverseRange(lines[screenRow], startCol, endCol);
  }
}

/**
 * 取选区覆盖的可见文本。行内区间用 `visibleSlice` 按显示列切，
 * 行之间用 `\n` 连起来——与终端原生复制的结果一致（每行末尾不留空格）。
 */
export function selectionText(lines: readonly string[], selection: Selection): string {
  const { anchor, head } = selection;
  const reversed = anchor.row > head.row || (anchor.row === head.row && anchor.col > head.col);
  const first = reversed ? head : anchor;
  const last = reversed ? anchor : head;
  const out: string[] = [];
  for (let row = first.row; row <= last.row; row++) {
    if (row < 0 || row >= lines.length) continue;
    const startCol = row === first.row ? first.col : 0;
    const endCol = row === last.row ? last.col + 1 : Number.MAX_SAFE_INTEGER;
    out.push(visibleSlice(lines[row], startCol, endCol).replace(/\s+$/, ''));
  }
  return out.join('\n');
}

/**
 * 可回看的最大行数：历史长度减去视口能显示的行数。给 0 表示「无需滚动」。
 *
 * 与 composeFrame 共用 planFrame 的分配结果——两边各算一遍的话，只要有一处偏差
 * （比如活动区行数只被一边计入），PgUp 就会在末尾多滚出一行空白。
 */
export function maxScroll(bodyRows: number, live: LiveView, height: number): number {
  const plan = planFrame(Math.max(1, height), live);
  return Math.max(0, bodyRows - plan.body);
}

/**
 * 滚动锚定：历史在**视口上方**长高时，把偏移同步推上去，视口才会停在原处。
 *
 * 触发场景是流式正文在底部增长：不推偏移的话视口会自己往下滑、慢慢露出新内容，
 * 用户正在读的那一段就飘走了。
 *
 * 两条边界：
 * - `scroll === 0`（贴底）时不动 —— 这时候跟随最新才是正确行为。
 * - 只在变长时调整。长度骤减（/clear、切会话）不该反向修正，那种情况由调用方重置偏移。
 */
export function anchorScroll(scroll: number, previousLength: number, currentLength: number): number {
  if (scroll <= 0 || currentLength <= previousLength) return scroll;
  return scroll + (currentLength - previousLength);
}

function noticeMark(level: NoticeLevel): string {
  if (level === 'error') return '[x]';
  if (level === 'warn') return '[!]';
  if (level === 'success') return '[+]';
  return '[-]';
}

function noticePaint(level: NoticeLevel, styler: Styler): (text: string) => string {
  if (level === 'error') return (text) => styler.red(text);
  if (level === 'warn') return (text) => styler.yellow(text);
  if (level === 'success') return (text) => styler.green(text);
  return (text) => styler.dim(text);
}

function detailLines(
  text: string,
  width: number,
  paint?: (text: string) => string,
): DialogLine[] {
  if (text === '') return [];
  return wrap(text, Math.max(8, width - 2)).map((line) => ({ text: line, paint }));
}

function approvalPanel(
  prompt: ApprovalPrompt,
  width: number,
  styler: Styler,
): string[] {
  const { request } = prompt;
  const choices: ReadonlyArray<DialogChoice> = [
    { label: 'Allow once', selected: prompt.choice === 'allow' },
    { label: `Allow ${request.tool} for this session`, selected: prompt.choice === 'allow-session' },
    { label: 'Reject', selected: prompt.choice === 'deny' },
  ];
  const lines: DialogLine[] = [
    { text: `Allow ${request.tool} to run?`, paint: styler.bold },
    ...detailLines(request.command ?? request.path ?? '', width),
  ];
  if (prompt.note) lines.push(...detailLines(prompt.note, width, styler.dim));
  return renderDialog({
    width,
    title: 'Tool approval',
    marker: '[!]',
    titlePaint: styler.yellow,
    lines,
    choices,
    footer: '[Up/Down] select | [Enter] confirm | [y/n/a] shortcuts | [Esc] reject',
    styler,
  });
}

function askPanel(question: string, width: number, styler: Styler): string[] {
  return renderDialog({
    width,
    title: 'Question from the model',
    marker: '[?]',
    titlePaint: styler.cyan,
    lines: detailLines(question, width),
    footer: '[Enter] answer | [Esc] cancel (the model is told you did not answer)',
    styler,
  });
}

/** 输入框的可见宽度上限：够放 6 位数加单位，再宽也只是把边框拉长。 */
const FORM_INPUT_MAX = 28;
const FORM_INPUT_MIN = 10;

/**
 * 多字段表单浮层：一屏填完多个值，一次提交。
 *
 * 焦点用**反显**表达（与菜单选中项同一套语汇）：聚焦字段反显它的输入区，聚焦按钮反显整个
 * 按钮块。光标交给终端（返回值里的 cursor），不用 `>` 之类的假光标——字段可能不止一个，
 * 假光标会在每行都出现，反而看不出焦点在哪。
 *
 * 返回值里的 cursor.row 是**相对本面板**的行号，调用方要加上面板在活动区里的起始行。
 */
function formPanel(
  prompt: FormPrompt,
  width: number,
  styler: Styler,
): { lines: string[]; cursor: { row: number; col: number } | null } {
  const labelWidth = prompt.fields.reduce((max, field) => Math.max(max, displayWidth(field.label)), 0);
  const inputWidth = Math.max(
    FORM_INPUT_MIN,
    Math.min(FORM_INPUT_MAX, width - 4 - labelWidth - CHOICE_GAP),
  );

  const lines: DialogLine[] = [];
  lines.push(...detailLines(prompt.note ?? '', width, styler.dim));
  lines.push({ text: '' });

  // 字段行在 lines 里的起点。renderDialog 会在内容前再插「上边框 + 标题」两行，
  // 所以光标行号最后要整体 +2。
  const fieldStart = lines.length;
  let caretInFocus = 0;
  for (const [index, field] of prompt.fields.entries()) {
    const focused = prompt.focus === index;
    const row = formFieldRow(field, focused, labelWidth, inputWidth, styler);
    if (focused) caretInFocus = row.caret;
    lines.push({ text: row.text });
  }

  const cursor = prompt.focus >= prompt.fields.length
    ? null
    : {
      row: 2 + fieldStart + prompt.focus,
      // renderDialogLine 已经给内容行加了 2 列缩进，这里只补「标签列 + 间隔 + 输入区内的偏移」。
      col: 2 + labelWidth + CHOICE_GAP + caretInFocus,
    };

  if (prompt.error !== undefined && prompt.error !== '') {
    lines.push({ text: '' });
    lines.push(...detailLines(prompt.error, width, styler.red));
  }

  // 刻意不渲染确认/取消按钮行：Enter 就是确认、Esc 就是取消，页脚已经写明，
  // 按钮行只会把弹窗撑高一截，还要多养一套「焦点落在按钮上」的按键语义。
  return {
    lines: renderDialog({
      width,
      title: prompt.title,
      titlePaint: styler.cyan,
      lines,
      footer: prompt.fields.length === 0
        ? '[Enter] confirm | [Esc] cancel'
        : '[Tab/Up/Down] switch field | [Enter] submit | [Esc] cancel',
      styler,
    }),
    cursor,
  };
}

/**
 * 单个字段行：`标签列 + 间隔 + 输入区`。
 *
 * 输入区宽度固定，所以空字段显示的是 placeholder（压成 dim，与真值区分）；文本超出时向左
 * 滚动（保留光标附近的尾部），这是单行输入框的通用行为，而不是硬截断——否则用户敲到第 29
 * 个字符时看不到自己正在敲什么。
 */
function formFieldRow(
  field: FormPrompt['fields'][number],
  focused: boolean,
  labelWidth: number,
  inputWidth: number,
  styler: Styler,
): { text: string; caret: number } {
  // 不加自己的缩进：内容和说明行都走 renderDialogLine，那一层统一加 2 列，
  // 自己再加一次就会比说明行多缩进 2 列，光标列也跟着偏。
  const label = `${pad(field.label, labelWidth)}${' '.repeat(CHOICE_GAP)}`;
  const empty = field.editor.text === '';
  const caretCol = empty ? 0 : cursorColumn(field.editor);
  // 输入区留 1 格左内边距：内容不再紧贴标签间隔，光标也有落点（缩进 1 格）。
  const inner = Math.max(1, inputWidth - 1);
  const start = Math.max(0, caretCol + 1 - inner);
  const content = empty ? field.placeholder : field.editor.text;
  const shown = pad(` ${visibleSlice(content, start, start + inner)}`, inputWidth);
  const body = empty ? styler.dim(shown) : shown;
  return {
    // 反显整块输入区（含尾部空白）才像「一个选中的输入框」；只反显文字会像随手高亮。
    text: `${label}${focused ? styler.inverse(body) : body}`,
    caret: caretCol - start + 1,
  };
}

function planPanel(plan: string, width: number, budget: number, styler: Styler): string[] {
  const body = wrap(plan, Math.max(8, width - 2));
  const shown = body.slice(0, budget);
  const lines: DialogLine[] = shown.map((line) => ({ text: line }));
  if (body.length > shown.length) lines.push({ text: `... ${body.length - shown.length} more lines`, paint: styler.dim });
  return renderDialog({
    width,
    title: 'Plan awaiting review',
    marker: '[!]',
    titlePaint: styler.yellow,
    lines,
    footer: '[y] approve and run | type feedback then [Enter] to refuse | [Esc] refuse',
    styler,
  });
}

/** 菜单项提示列至少要留出的列数，保证窄终端下提示仍可读。 */
const HINT_MIN_COLUMNS = 12;

function menuPanel(menu: TuiState['menu'], width: number, budget: number, styler: Styler): string[] {
  if (!menu) return [];
  const rows = Math.max(1, Math.min(budget, menu.items.length));
  const start = Math.max(0, Math.min(menu.index - Math.floor(rows / 2), menu.items.length - rows));
  const header = menu.filter ? `${menu.title} | filter “${menu.filter}”` : menu.title;
  const lines: DialogLine[] = [];
  const choices: DialogChoice[] = [];
  if (menu.items.length === 0) {
    lines.push({ text: 'No matching commands', paint: styler.dim });
  } else {
    const visible = menu.items.slice(start, start + rows);
    // 标签列宽按可见项动态取：命令名（/model，6 列）和模型 ID（DeepSeek-V4-Pro-08，18 列）
    // 长度差一倍，写死一个列宽必然在长标签上失效。上限给提示列留 HINT_MIN_COLUMNS 列，
    // 窄终端下宁可截提示，也不让标签把提示整列挤没。
    const widest = visible.reduce((max, item) => Math.max(max, displayWidth(item.label)), 0);
    const labelWidth = Math.max(0, Math.min(widest, width - CHOICE_GAP - HINT_MIN_COLUMNS));
    for (let i = start; i < start + rows; i++) {
      const item = menu.items[i];
      choices.push({
        label: item.label,
        hint: item.hint,
        labelWidth,
        selected: i === menu.index,
      });
    }
  }
  if (menu.items.length > rows) lines.push({ text: `(${menu.index + 1}/${menu.items.length})`, paint: styler.dim });
  return renderDialog({
    width,
    title: header,
    titlePaint: styler.cyan,
    lines,
    choices,
    footer: menu.nested ? '[Up/Down] select | [Enter] confirm | [Esc] back' : '[Up/Down] select | [Enter] run | [Esc] cancel',
    styler,
  });
}

function statusPanel(state: TuiState, width: number, styler: Styler): string[] {
  const pressure = state.contextWindow > 0 ? state.usage.lastPrompt / state.contextWindow : 0;
  const rows: Array<[string, string, (text: string) => string]> = [
    ['Session', state.sessionId, (text) => text],
    ['Workspace', state.workspaceRoot, (text) => styler.dim(text)],
    ['Model', `${state.model} (${state.api}${state.effort ? `, ${state.effort}` : ''})`, (text) => styler.bold(text)],
    ['Approval', state.approvalMode, approvalTone(state.approvalMode, styler)],
    ['Sandbox', `${state.sandboxMode} (${state.sandboxEnforcement})`, sandboxTone(state.sandboxMode, styler)],
    [
      'Context',
      state.usage.lastPrompt > 0
        ? `${progressBar(pressure, 16)} ${Math.round(pressure * 100)}% (${formatTokens(state.usage.lastPrompt)} / ${formatTokens(state.contextWindow)})`
        : 'No model call in this turn yet',
      pressureTone(pressure, styler),
    ],
    ['Usage', `+${formatTokens(state.usage.prompt)} / -${formatTokens(state.usage.completion)}`, (text) => styler.dim(text)],
    [
      'Cache hit',
      (() => {
        const hit = cacheHitRate(state.usage);
        if (hit === undefined) return 'Endpoint reports no cache usage';
        return `${Math.round(hit * 100)}% (${formatTokens(state.usage.cached)} / ${formatTokens(state.usage.prompt)})`;
      })(),
      (text) => styler.dim(text),
    ],
    [
      'To-dos',
      state.todo.total === 0
        ? '(none)'
        : `${state.todo.done}/${state.todo.total}${state.todo.current ? ` | ${state.todo.current}` : ''}`,
      state.todo.total > 0 && state.todo.done < state.todo.total
        ? (text) => styler.cyan(text)
        : (text) => styler.dim(text),
    ],
    [
      'Jobs',
      state.jobs === 0 ? 'none' : `${state.jobs} running`,
      state.jobs > 0 ? (text) => styler.yellow(text) : (text) => styler.dim(text),
    ],
    ['MCP', `${state.mcpServers} servers | ${state.mcpTools} tools`, (text) => styler.dim(text)],
    ['Plan mode', state.planMode ? 'on' : 'off', state.planMode ? (text) => styler.magenta(text) : (text) => styler.dim(text)],
  ];
  const budget = Math.max(8, width - 12);
  const lines: DialogLine[] = [];
  for (const [label, value, paint] of rows) {
    lines.push({
      text: `${styler.dim(`  ${pad(label, 10)}`)}${paint(truncate(value, budget, ''))}`,
      indent: 0,
    });
  }
  return renderDialog({
    width,
    title: 'Status',
    titlePaint: styler.cyan,
    lines,
    footer: '[any key] back',
    styler,
  });
}

// ---------------------------------------------------------------- 滚动区

/** 一步（一次 LLM 调用）里可展开的条目：思考链 + 这次调用发起的各个工具。 */
export interface StepThinkingView {
  text: string;
  /** 思考已经结束（拿到权威全文）。运行中的思考会给末尾几行预览。 */
  done?: boolean;
  /** 思考耗时（毫秒），用于 `Thought for 1.2s`。 */
  ms?: number;
  /** 二级展开：思考正文是否整篇可见（默认只给一行标签或末尾几行）。 */
  expanded?: boolean;
}

/** `onRows` 回传的行区间（相对块首行），供双击命中测试用。 */
export interface StepBlockRows {
  thinking?: { start: number; end: number };
  items: Array<{ start: number; end: number } | undefined>;
}

/** 运行中的思考只预览末尾几行：开头早就读过了，「刚想到哪」才是实时信息。 */
const THINKING_TAIL_LINES = 3;

/** 思考行的标签，照 grok-build：运行中 `Thinking…`，结束后 `Thought for 1.2s`。 */
function thinkingLabel(thinking: StepThinkingView): string {
  if (thinking.done !== true) return 'Thinking…';
  const ms = thinking.ms ?? 0;
  return ms > 0 ? `Thought for ${formatDuration(ms)}` : 'Thought';
}

/**
 * 一步的执行块：三级展开。
 *
 *   0 折叠   —— 只有块头（`Read 2 files, Ran 1 command | 1 failed | 8.9s`）
 *   1 展开块 —— 块头 + 思考链一行 + 每个工具一行
 *   2 展开行 —— 该行自己的正文（思考全文 / 工具结果）
 *
 * 汇总标签照 grok-build 的写法：按动词分桶、桶内去重（`Read 2 files` 是「读了两个文件」，
 * 不是「调了两次 read_file」）；思考链单列一行、**不计入**工具统计。
 *
 * `onRows` 回传每行在块内的行区间，供双击命中测试用——行高随折行变化，调用方不能靠数行数猜。
 */
export function renderStepBlock(
  thinking: StepThinkingView | undefined,
  items: readonly ToolCallView[],
  options: ViewOptions,
  expanded = false,
  onRows?: (rows: StepBlockRows) => void,
): string[] {
  const hasThinking = thinking !== undefined && thinking.text.trim() !== '';
  if (!hasThinking && items.length === 0) return [];
  const { width, styler } = options;
  const out: string[] = [];
  const total = items.reduce((sum, item) => sum + (item.durationMs ?? 0), 0);
  const failed = items.filter((item) => item.ok === false).length;
  const run = summarizeToolRun(items);
  const parts: string[] = [];
  if (run.label !== '') parts.push(run.label);
  if (failed > 0) parts.push(`${failed} failed`);
  if (total > 0) parts.push(formatDuration(total));
  // 只有思考、没有工具的一步：块头就是思考的标签，不然只剩一个光秃秃的耗时。
  if (parts.length === 0 && thinking) parts.push(thinkingLabel(thinking));
  // 宽度不够时**先丢键位提示**，再截数据：提示是学一次就记住的东西，
  // 而汇总标签、失败数、耗时是这一步的实情。
  const hint = expanded ? 'double-click a line for details' : 'double-click to expand';
  const data = parts.join(SEPARATOR);
  const head = displayWidth(`${data}${SEPARATOR}${hint}`) <= width - 2
    ? `${data}${SEPARATOR}${hint}`
    : truncate(data, Math.max(1, width - 2), '');
  out.push(`  ${styler.dim(truncate(head, Math.max(1, width - 2), ''))}`);

  const rows: StepBlockRows = { items: [] };
  if (!expanded) {
    onRows?.(rows);
    return out;
  }

  if (hasThinking && thinking) {
    const start = out.length;
    out.push(...thinkingLines(thinking, width, styler));
    rows.thinking = { start, end: out.length };
  }
  items.forEach((item, index) => {
    const start = out.length;
    out.push(toolSummaryLine(item, width, styler));
    if (item.expanded === true) {
      out.push(...renderToolDetail(item, {
        width,
        indent: 4,
        maxLines: Number.POSITIVE_INFINITY,
        styler,
      }));
    }
    rows.items[index] = { start, end: out.length };
  });
  onRows?.(rows);
  return out;
}

/**
 * 思考链行，三种形态：
 *
 * - 运行中：`Thinking…` + 末尾 3 行——实时反馈只需要「还在动、刚想到哪」；
 * - 已结束：一行 `Thought for 1.2s`——几十行推理不该在历史里占版面；
 * - 展开：整篇正文，供真要读推理过程的场合。
 */
function thinkingLines(thinking: StepThinkingView, width: number, styler: Styler): string[] {
  const indent = '  ';
  const body = wrap(thinking.text, Math.max(8, width - indent.length * 2));
  const label = `${indent}${styler.dim(thinkingLabel(thinking))}`;
  if (thinking.expanded === true) {
    return [label, ...body.map((line) => `${indent}${indent}${styler.dim(line)}`)];
  }
  if (thinking.done !== true) {
    const tail = body.slice(-THINKING_TAIL_LINES);
    return [label, ...tail.map((line) => `${indent}${indent}${styler.dim(line)}`)];
  }
  return [label];
}

/** 摘要行：工具名（按成败着色）+ 摘要左对齐，耗时右对齐成一列。 */
function toolSummaryLine(item: ToolCallView, width: number, styler: Styler): string {
  const indent = 2;
  const duration = formatDuration(item.durationMs);
  const durationWidth = duration === '' ? 0 : duration.length + 2;
  const budget = Math.max(8, width - indent - durationWidth);
  const nameWidth = displayWidth(item.name);
  const summaryBudget = budget - nameWidth - 1;
  const head = summaryBudget >= 6
    ? `${item.name} ${truncate(summarizeToolCall(item), summaryBudget, '')}`
    : truncate(item.name, budget, '');
  const filler = duration === '' ? 0 : Math.max(1, width - indent - displayWidth(head) - duration.length);
  const tail = duration === '' ? '' : `${' '.repeat(filler)}${styler.dim(duration)}`;
  return `${' '.repeat(indent)}${toolTone(item.ok, styler)(head)}${tail}`;
}

/**
 * 表格边框字符集。
 *
 * 默认 Unicode 制表符（观感接近现代终端工具）。制表符属东亚歧义宽度字符：本项目按 1 列
 * 计量，若终端把它渲染成 2 列，整帧会向右溢出——设 SPH_TABLE_BORDER=ascii 退回 `+--+` 边框。
 */
function tableBorder(): 'ascii' | 'box' {
  const raw = (process.env.SPH_TABLE_BORDER ?? '').trim().toLowerCase();
  return raw === 'ascii' || raw === 'plain' ? 'ascii' : 'box';
}

/** 已提交条目 → 滚动区行。写进终端历史后就不再变，因此可以放心着色。 */
export function renderEntry(entry: TranscriptEntry, options: ViewOptions): string[] {
  const { width, styler } = options;
  switch (entry.kind) {
    case 'user':
      // 用户输入不做 markdown 重排：用户打 `*` 往往就是想要个星号，把 `#` 变标题、
      // `- ` 变圆点会让他怀疑输入被改写了。只把 @提及 标出来（参考实现两端也是这个选择）。
      return prefixed('> ', entry.text, width, (t) => styler.cyan(t), (t) => highlightMentions(t, styler));
    case 'assistant':
      // 给模型输出留出稳定的视觉层级，同时让 markdown 渲染器按缩进后的可用宽度排版。
      return renderMarkdown(entry.text, {
        width,
        indent: 2,
        styler,
        highlighter: createHighlighter,
        tableBorder: tableBorder(),
      });
    case 'thinking': {
      if (!entry.text) return [];
      const body = wrap(entry.text, Math.max(8, width - 2));
      if (body.length === 0) return [];
      const head = `${body[0]}${body.length > 1 ? ` ... (${body.length} lines)` : ''}`;
      const lines = [styler.dim(`[thinking] ${truncate(head, Math.max(8, width - 6), '')}`)];
      if (entry.collapsed === false) {
        for (const line of body.slice(1)) lines.push(styler.dim(`  ${line}`));
      }
      return lines;
    }
    case 'tool':
      // 回放的单条工具条目：没有思考链，也谈不上聚合，直接当作只有一个工具的一步。
      return renderStepBlock(undefined, [toolCallOf(entry)], options, entry.collapsed === false);
    case 'notice':
      return wrap(entry.text, Math.max(8, width - 4)).map((line, index) =>
        noticePaint(entry.level ?? 'info', styler)(`${index === 0 ? `${noticeMark(entry.level ?? 'info')} ` : '  '}${line}`),
      );
    case 'error':
      return wrap(entry.text, Math.max(8, width - 4)).map((line, index) =>
        styler.red(`${index === 0 ? '[!] ' : '  '}${line}`),
      );
  }
}

/** 条目 → 工具块入参：回放路径与实时路径复用同一套摘要/正文渲染。 */
export function toolCallOf(entry: TranscriptEntry): ToolCallView {
  return {
    id: entry.id ?? '',
    name: entry.label ?? 'tool',
    args: entry.args ?? {},
    detail: entry.detail ?? '',
    ok: entry.ok,
    durationMs: entry.durationMs,
  };
}

function prefixed(
  prefix: string,
  text: string,
  width: number,
  paintPrefix: (text: string) => string,
  paintBody?: (text: string) => string,
): string[] {
  const body = wrap(text, Math.max(8, width - prefix.length));
  if (body.length === 0) return [];
  return body.map((line, index) => {
    const head = index === 0 ? paintPrefix(prefix) : ' '.repeat(prefix.length);
    return `${head}${paintBody ? paintBody(line) : line}`;
  });
}

/**
 * 用户输入里的 @提及 高亮。
 *
 * 只插入 SGR、不增删字符，因此不会影响宽度计算。刻意写得保守：要求 @ 前面是行首或
 * 空白/左括号，避免把邮箱（a@b.com）里的 @ 也点亮。
 */
function highlightMentions(text: string, styler: Styler): string {
  return text.replace(
    /(^|[\s(（[【])@([^\s，。；、,;()（）[\]【】]+)/g,
    (_all, lead: string, name: string) => `${lead}${styler.cyan(`@${name}`)}`,
  );
}

// ---------------------------------------------------------------- 区域 1：标题栏

/** 标题栏文案。收在常量里，测试与文档都引用同一份，不会各写各的。 */
export const HEADER_TITLE = 'SPRING HARNESS';

/**
 * 标题栏（区域 1，固定 1 行）：
 *
 *   SPRING HARNESS v0.1.0            spring-harness | main
 *
 * 左半是品牌标识 + 版本号，右半是「我在哪儿」的位置信息。版本号取自 package.json
 * （state.version），不在这里再写一份常量。
 *
 * 两侧内容**各自独立截断**：先按显示宽度算出右侧可用列，右侧不够就整块放弃（位置信息
 * 比版本号次要），左侧不够才截断标题。这样窄终端下丢掉的是「在哪」而不是「是什么」。
 * 版本号在极窄时随标题一起被截——它属于标识的一部分，不该单独留个孤零零的数字。
 */
export function renderHeader(state: TuiState, options: ViewOptions): string {
  const { width, styler } = options;
  const left = `${styler.bold(HEADER_TITLE)}${state.version === '' ? '' : styler.dim(` v${state.version}`)}`;
  const leftWidth = displayWidth(HEADER_TITLE) + (state.version === '' ? 0 : ` v${state.version}`.length);

  const parts = [state.projectName];
  if (state.branch) parts.push(state.branch);
  const right = parts.join(SEPARATOR);
  const rightWidth = displayWidth(right);

  // 至少留 2 列空隙，否则左右会粘在一起读不出来。
  if (leftWidth + rightWidth + 2 > width) {
    return truncate(left, width, '');
  }
  const gap = Math.max(1, width - leftWidth - rightWidth);
  return `${left}${' '.repeat(gap)}${styler.dim(right)}`;
}

/**
 * 首屏横幅（对话流的第一条内容，**不是**固定区域）。
 *
 * 标题与位置信息已由标题栏接管，这里只留「本次会话用什么跑」与键位提示——两处都不重复。
 */
export function renderBanner(state: TuiState, options: ViewOptions): string[] {
  const { width, styler } = options;
  return [
    composeSegments(
      [
        { text: state.model, paint: (text) => styler.bold(text), priority: 4 },
        { text: state.api, paint: (text) => styler.dim(text), priority: 3 },
        { text: `approval ${state.approvalMode}`, paint: approvalTone(state.approvalMode, styler), priority: 2 },
        { text: `sandbox ${state.sandboxMode}`, paint: sandboxTone(state.sandboxMode, styler), priority: 1 },
      ],
      width,
      styler,
    ),
    '',
    styler.dim(truncate('Enter send | Ctrl+J newline | / commands | Ctrl+K all actions | /status | /help', width, '')),
  ];
}
