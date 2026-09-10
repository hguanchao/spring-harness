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
import { displayWidth, pad, truncate, wrap } from './ansi.js';
import { scrollEditor } from './editor.js';
import type { NoticeLevel, TranscriptEntry, TuiState } from './state.js';
import { cacheHitRate } from './state.js';
import { formatDuration, renderToolDetail, summarizeToolCall, toolTone, type ToolCallView } from './tool-view.js';

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

/** 正文行数上限：单工具块留得下细节，多工具块只留预览，失败项多留几行。 */
const DETAIL_SINGLE = 8;
const DETAIL_MULTI_OK = 2;
const DETAIL_MULTI_FAIL = 6;

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
 *   项目 | 分支 | 模型 | 推理等级 | 上下文 | 缓存命中率 | 权限模式
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

  segments.push({ text: `${ICON.project} ${state.projectName}`, paint: (v) => styler.cyan(v), priority: 8 });
  if (state.branch) {
    segments.push({ text: `${ICON.branch} ${state.branch}`, paint: (v) => styler.magenta(v), priority: 8 });
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
  if (state.sandboxMode === 'off') segments.push({ text: '沙箱 off', paint: (v) => styler.red(v), priority: 7 });

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
  return segments;
}

// ---------------------------------------------------------------- 活动区

/** 活动区渲染：浮层（若有）+ 输入行 + 提示行 + notice + 状态行。 */
export function renderLive(state: TuiState, options: ViewOptions): LiveView {
  const { width, styler } = options;
  const now = options.now ?? Date.now();
  const budget = Math.max(4, Math.min(12, options.height - 7));
  const lines: string[] = [];
  let cursor: { row: number; col: number } | null = null;

  const prompt = state.prompt;
  if (prompt?.kind === 'approval') {
    lines.push(...approvalPanel(prompt.request, prompt.note, width, styler));
  } else if (prompt?.kind === 'ask') {
    lines.push(...askPanel(prompt.question, width, styler));
    const input = inputLine(prompt.editor, width, styler);
    cursor = { row: lines.length, col: input.column };
    lines.push(input.line);
  } else if (prompt?.kind === 'plan') {
    lines.push(...planPanel(prompt.plan, width, budget, styler));
    const input = inputLine(prompt.editor, width, styler);
    cursor = { row: lines.length, col: input.column };
    lines.push(input.line);
  } else if (state.phase === 'menu' && state.menu) {
    lines.push(...menuPanel(state.menu, width, budget, styler));
    const input = inputLine(state.editor, width, styler);
    cursor = { row: lines.length, col: input.column };
    lines.push(input.line);
  } else if (state.phase === 'status') {
    lines.push(...statusPanel(state, width, styler));
  } else {
    const input = inputLine(state.editor, width, styler);
    cursor = { row: lines.length, col: input.column };
    lines.push(input.line);
  }

  const hint = hintLine(state);
  if (hint) lines.push(hint.tone === 'warn'
    ? styler.yellow(truncate(hint.text, width, ''))
    : styler.dim(truncate(hint.text, width, '')));
  if (state.notice) lines.push(noticeLine(state.notice, width, styler));
  lines.push(composeSegments(statusSegments(state, styler, now), width, styler));

  // 活动区硬上限：必须给历史视口留出至少一行，否则整屏只有输入框，看起来像卡死了。
  const maxRows = Math.max(3, options.height - 1);
  if (lines.length > maxRows) {
    const drop = lines.length - maxRows;
    lines.splice(0, drop);
    cursor = cursor && cursor.row - drop >= 0 ? { row: cursor.row - drop, col: cursor.col } : null;
  }
  return { lines, cursor };
}

// ---------------------------------------------------------------- 整帧

/**
 * 把「历史视口 + 底部活动区」组合成**正好一屏**的整帧。
 *
 * 布局约定：活动区钉在屏幕底部（输入行位置固定，视线不用每次去找），历史从下往上填满
 * 剩余空间。scroll=0 时贴着最新内容；scroll 越大越往早前看。历史不足一屏时**在顶部补
 * 空行**而不是让活动区上浮——否则输入行会随内容多少上下跳。
 *
 * 调用方负责把 scroll 夹到有效范围内（见 app 的 maxScroll 计算），这里只做防御性收敛。
 */
export function composeFrame(
  body: readonly string[],
  live: LiveView,
  options: ViewOptions,
  scroll: number,
): LiveView {
  const height = Math.max(3, options.height);
  const liveLines = live.lines.slice(Math.max(0, live.lines.length - (height - 1)));
  const dropped = live.lines.length - liveLines.length;
  const bodyRows = height - liveLines.length;

  const offset = Math.max(0, Math.floor(scroll));
  const end = Math.max(0, Math.min(body.length, body.length - offset));
  const start = Math.max(0, end - bodyRows);
  const blank = bodyRows - (end - start);

  const lines = [...new Array<string>(blank).fill(''), ...body.slice(start, end), ...liveLines];
  const cursorRow = bodyRows + (live.cursor ? live.cursor.row - dropped : 0);
  const cursor = live.cursor && live.cursor.row - dropped >= 0
    ? { row: cursorRow, col: live.cursor.col }
    : null;
  return { lines, cursor };
}

/**
 * 可回看的最大行数：历史长度减去一屏能显示的行数。给 0 表示「无需滚动」。
 * 夹在调用方而不是 composeFrame 里，是为了让 PgUp 顶到开头时偏移不再无限增长。
 */
export function maxScroll(bodyRows: number, liveRows: number, height: number): number {
  return Math.max(0, bodyRows - Math.max(1, height - liveRows));
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

function noticeLine(notice: NonNullable<TuiState['notice']>, width: number, styler: Styler): string {
  return noticePaint(notice.level, styler)(truncate(`${noticeMark(notice.level)} ${notice.text}`, width, ''));
}

function inputLine(editor: TuiState['editor'], width: number, styler: Styler): { line: string; column: number } {
  const available = Math.max(1, width - 2);
  const { segments, cursorColumn } = scrollEditor(editor, available);
  return { line: `${styler.cyan('> ')}${segments.join('')}`, column: 2 + cursorColumn };
}

function hintLine(state: TuiState): { text: string; tone: 'dim' | 'warn' } | undefined {
  if (state.prompt) return undefined;
  // 回看时提示行让位给「怎么回到最新」——这时候用户真正需要知道的是这一条。
  // 只写实际接了的键：End 是行尾键，不能写进这里。
  if (state.scroll > 0) {
    return { text: `已上翻 ${state.scroll} 行 | PgDn / Esc 回到最新`, tone: 'warn' };
  }
  if (state.phase === 'menu') {
    return {
      text: state.menu?.nested ? '上下键 选择 | Enter 确认 | Esc 返回' : '上下键 选择 | Enter 执行 | Esc 取消',
      tone: 'dim',
    };
  }
  if (state.phase === 'status') return { text: '任意键返回', tone: 'dim' };
  if (state.phase === 'running') return { text: '运行中 | Esc 中断本轮 | Ctrl+C 退出', tone: 'dim' };
  return { text: 'Enter 发送 | / 命令菜单 | Ctrl+K 全部操作 | PgUp 回看 | Ctrl+C 退出', tone: 'dim' };
}

function overlayTitle(mark: string, title: string, width: number, styler: Styler): string {
  return truncate(styler.yellow(`${mark} ${title}`), width, '');
}

function keysLine(text: string, width: number, styler: Styler): string {
  return styler.dim(truncate(`  ${text}`, width, ''));
}

function detailLines(
  text: string,
  width: number,
  paint?: (text: string) => string,
): string[] {
  if (text === '') return [];
  return wrap(text, Math.max(8, width - 2)).map((line) => (paint ? paint(`  ${line}`) : `  ${line}`));
}

function approvalPanel(
  request: { tool: string; command?: string; path?: string },
  note: string | undefined,
  width: number,
  styler: Styler,
): string[] {
  const out = [overlayTitle('[!]', `需要审批 | ${request.tool}`, width, styler)];
  out.push(...detailLines(request.command ?? request.path ?? '', width));
  if (note) out.push(...detailLines(note, width, (text) => styler.dim(text)));
  out.push(keysLine('[y] 允许 | [n] 拒绝 | [a] 本会话总是允许 | [Esc] 拒绝', width, styler));
  return out;
}

function askPanel(question: string, width: number, styler: Styler): string[] {
  const out = [overlayTitle('[?]', '模型提问', width, styler)];
  out.push(...detailLines(question, width));
  out.push(keysLine('[Enter] 回答 | [Esc] 取消（模型会收到「未回答」）', width, styler));
  return out;
}

function planPanel(plan: string, width: number, budget: number, styler: Styler): string[] {
  const out = [overlayTitle('[!]', '计划待审批', width, styler)];
  const body = wrap(plan, Math.max(8, width - 2));
  const shown = body.slice(0, budget);
  for (const line of shown) out.push(`  ${line}`);
  if (body.length > shown.length) out.push(styler.dim(`  ... 其余 ${body.length - shown.length} 行`));
  out.push(keysLine('[y] 批准并执行 | 输入意见后 [Enter] 驳回 | [Esc] 驳回', width, styler));
  return out;
}

function menuPanel(menu: TuiState['menu'], width: number, budget: number, styler: Styler): string[] {
  if (!menu) return [];
  const rows = Math.max(1, Math.min(budget, menu.items.length));
  const start = Math.max(0, Math.min(menu.index - Math.floor(rows / 2), menu.items.length - rows));
  const header = menu.filter ? `${menu.title} | 过滤「${menu.filter}」` : menu.title;
  const out = [truncate(styler.bold(styler.cyan(header)), width, '')];
  if (menu.items.length === 0) {
    out.push(styler.dim('  （无匹配命令）'));
    return out;
  }
  for (let i = start; i < start + rows; i++) {
    const item = menu.items[i];
    const column = `  ${pad(item.label, 18)}`;
    const plain = truncate(`${column}${item.hint}`, width, '');
    if (i === menu.index) {
      // 反显整行：纯文本先补齐到整宽再着色，形成连续的选中条，且不会被截断。
      out.push(styler.inverse(pad(plain, width)));
    } else {
      // 非选中行只把说明压暗，值保持默认前景；hint 部分按列宽截断后的余量切出来。
      const label = truncate(column, width, '');
      const hint = plain.slice(label.length);
      out.push(`${label}${hint === '' ? '' : styler.dim(hint)}`);
    }
  }
  if (menu.items.length > rows) out.push(styler.dim(`  (${menu.index + 1}/${menu.items.length})`));
  return out;
}

function statusPanel(state: TuiState, width: number, styler: Styler): string[] {
  const pressure = state.contextWindow > 0 ? state.usage.lastPrompt / state.contextWindow : 0;
  const rows: Array<[string, string, (text: string) => string]> = [
    ['项目', state.projectName, (text) => styler.cyan(text)],
    ['分支', state.branch ?? '（不在 git 仓库）', state.branch ? (text) => styler.magenta(text) : (text) => styler.dim(text)],
    ['会话', state.sessionId, (text) => text],
    ['工作区', state.workspaceRoot, (text) => styler.dim(text)],
    ['模型', `${state.model} (${state.api}${state.effort ? `, ${state.effort}` : ''})`, (text) => styler.bold(text)],
    ['审批', state.approvalMode, approvalTone(state.approvalMode, styler)],
    ['沙箱', `${state.sandboxMode} (${state.sandboxEnforcement})`, sandboxTone(state.sandboxMode, styler)],
    [
      '上下文',
      state.usage.lastPrompt > 0
        ? `${progressBar(pressure, 16)} ${Math.round(pressure * 100)}% (${formatTokens(state.usage.lastPrompt)} / ${formatTokens(state.contextWindow)})`
        : '（本轮还没调用模型）',
      pressureTone(pressure, styler),
    ],
    ['用量', `+${formatTokens(state.usage.prompt)} / -${formatTokens(state.usage.completion)}`, (text) => styler.dim(text)],
    [
      '缓存',
      (() => {
        const hit = cacheHitRate(state.usage);
        if (hit === undefined) return '（端点未上报缓存用量）';
        return `${Math.round(hit * 100)}% (${formatTokens(state.usage.cached)} / ${formatTokens(state.usage.prompt)})`;
      })(),
      (text) => styler.dim(text),
    ],
    [
      'TODO',
      state.todo.total === 0
        ? '（空）'
        : `${state.todo.done}/${state.todo.total}${state.todo.current ? ` | ${state.todo.current}` : ''}`,
      state.todo.total > 0 && state.todo.done < state.todo.total
        ? (text) => styler.cyan(text)
        : (text) => styler.dim(text),
    ],
    [
      '后台',
      state.jobs === 0 ? '无' : `${state.jobs} 个运行中`,
      state.jobs > 0 ? (text) => styler.yellow(text) : (text) => styler.dim(text),
    ],
    ['MCP', `${state.mcpServers} 个服务 | ${state.mcpTools} 个工具`, (text) => styler.dim(text)],
    ['计划模式', state.planMode ? 'on' : 'off', state.planMode ? (text) => styler.magenta(text) : (text) => styler.dim(text)],
  ];
  const out = [styler.bold(styler.cyan('状态'))];
  const budget = Math.max(8, width - 12);
  for (const [label, value, paint] of rows) {
    out.push(`${styler.dim(`  ${pad(label, 10)}`)}${paint(truncate(value, budget, ''))}`);
  }
  return out;
}

// ---------------------------------------------------------------- 滚动区

/** 工具块：多工具时先给块头（数量 / 失败数 / 总耗时），再逐个「摘要 + 正文」。 */
export function renderToolBlock(items: readonly ToolCallView[], options: ViewOptions): string[] {
  if (items.length === 0) return [];
  const { width, styler } = options;
  const out: string[] = [];
  const multiple = items.length > 1;
  if (multiple) {
    const total = items.reduce((sum, item) => sum + (item.durationMs ?? 0), 0);
    const failed = items.filter((item) => item.ok === false).length;
    const parts = [`${items.length} 个工具调用`];
    if (failed > 0) parts.push(`${failed} 个失败`);
    if (total > 0) parts.push(formatDuration(total));
    out.push(styler.dim(parts.join(SEPARATOR)));
  }
  for (const item of items) {
    out.push(toolSummaryLine(item, width, styler));
    const maxLines = !multiple ? DETAIL_SINGLE : item.ok === false ? DETAIL_MULTI_FAIL : DETAIL_MULTI_OK;
    out.push(...renderToolDetail(item, { width, indent: 4, maxLines, styler }));
  }
  return out;
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

/** 已提交条目 → 滚动区行。写进终端历史后就不再变，因此可以放心着色。 */
export function renderEntry(entry: TranscriptEntry, options: ViewOptions): string[] {
  const { width, styler } = options;
  switch (entry.kind) {
    case 'user':
      return prefixed('> ', entry.text, width, (text) => styler.cyan(text));
    case 'assistant':
      return wrap(entry.text, width);
    case 'thinking': {
      if (!entry.text) return [];
      const body = wrap(entry.text, Math.max(8, width - 2));
      if (body.length === 0) return [];
      const head = `${body[0]}${body.length > 1 ? ` ...（共 ${body.length} 行）` : ''}`;
      const lines = [styler.dim(`[思考] ${truncate(head, Math.max(8, width - 6), '')}`)];
      if (entry.collapsed === false) {
        for (const line of body.slice(1)) lines.push(styler.dim(`  ${line}`));
      }
      return lines;
    }
    case 'tool':
      return renderToolBlock([toolCallOf(entry)], options);
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
function toolCallOf(entry: TranscriptEntry): ToolCallView {
  return {
    id: entry.id ?? '',
    name: entry.label ?? 'tool',
    args: entry.args ?? {},
    detail: entry.detail ?? '',
    ok: entry.ok,
    durationMs: entry.durationMs,
  };
}

function prefixed(prefix: string, text: string, width: number, paint: (text: string) => string): string[] {
  const body = wrap(text, Math.max(8, width - prefix.length));
  if (body.length === 0) return [];
  return body.map((line, index) => (index === 0 ? `${paint(prefix)}${line}` : `${' '.repeat(prefix.length)}${line}`));
}

// ---------------------------------------------------------------- 首屏横幅

export function renderBanner(state: TuiState, options: ViewOptions): string[] {
  const { width, styler } = options;
  return [
    `${styler.bold('Spring Harness')}${styler.dim(SEPARATOR)}${styler.cyan('交互模式')}`,
    composeSegments(
      [
        { text: state.model, paint: (text) => styler.bold(text), priority: 4 },
        { text: state.api, paint: (text) => styler.dim(text), priority: 3 },
        { text: `审批 ${state.approvalMode}`, paint: approvalTone(state.approvalMode, styler), priority: 2 },
        { text: `沙箱 ${state.sandboxMode}`, paint: sandboxTone(state.sandboxMode, styler), priority: 1 },
      ],
      width,
      styler,
    ),
    styler.dim(`工作区 ${truncate(state.workspaceRoot, Math.max(8, width - 4), '')}`),
    '',
    styler.dim(truncate('Enter 发送 | / 命令菜单 | Ctrl+K 全部操作 | /status 状态 | /help 帮助', width, '')),
  ];
}
