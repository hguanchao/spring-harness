/**
 * 纯渲染层：状态 → 屏幕行。没有任何 IO，也没有 TTY 依赖，可直接在测试里断言。
 *
 * 渲染模型是「行内（inline）」而不是全屏替代缓冲区：
 * - 对话正文由 app 直接写进终端原生滚动区，天然支持终端自身的滚动/搜索/复制；
 * - 这里只负责底部那块会重绘的「活动区」：浮层 + 输入行 + 提示行 + 状态行。
 * 因此 renderLive 返回的行必须每条都 <= width，app 才能确定「一行 = 一屏一行」，
 * 用「上移 N 行 + 清到屏幕末尾」精确重绘。
 *
 * 着色与截断的次序约定：先保证行宽不超限，再着色。反过来会截断掉结尾的复位序列，
 * 让颜色泄漏到后续内容上。
 */

import type { Styler } from './ansi.js';
import { pad, truncate, wrap } from './ansi.js';
import { scrollEditor } from './editor.js';
import type { TranscriptEntry, TuiState } from './state.js';

export interface ViewOptions {
  width: number;
  height: number;
  styler: Styler;
}

export interface LiveView {
  lines: string[];
  /** 终端光标位置（相对活动区首行）；null 表示隐藏光标。 */
  cursor: { row: number; col: number } | null;
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/** 活动区渲染：浮层（若有）+ 输入行 + 提示行 + 状态行。 */
export function renderLive(state: TuiState, options: ViewOptions): LiveView {
  const { width, styler } = options;
  const budget = Math.max(4, Math.min(12, options.height - 7));
  const lines: string[] = [];
  let cursor: { row: number; col: number } | null = null;
  const push = (line: string): void => {
    lines.push(pad(line, width));
  };

  const prompt = state.prompt;
  if (prompt?.kind === 'approval') {
    for (const line of approvalPanel(prompt.request, prompt.note, width, styler)) push(line);
  } else if (prompt?.kind === 'ask') {
    for (const line of askPanel(prompt.question, width, styler)) push(line);
    const row = lines.length;
    const input = inputLine(prompt.editor, width, styler);
    push(input.line);
    cursor = { row, col: input.column };
  } else if (prompt?.kind === 'plan') {
    for (const line of planPanel(prompt.plan, width, budget, styler)) push(line);
    const row = lines.length;
    const input = inputLine(prompt.editor, width, styler);
    push(input.line);
    cursor = { row, col: input.column };
  } else if (state.phase === 'menu' && state.menu) {
    for (const line of menuPanel(state.menu, width, budget, styler)) push(line);
    const row = lines.length;
    const input = inputLine(state.editor, width, styler);
    push(input.line);
    cursor = { row, col: input.column };
  } else if (state.phase === 'status') {
    for (const line of statusPanel(state, width, styler)) push(line);
  } else {
    const row = lines.length;
    const input = inputLine(state.editor, width, styler);
    push(input.line);
    cursor = { row, col: input.column };
  }

  const hint = hintLine(state);
  if (hint) push(styler.dim(pad(hint, width)));
  if (state.notice) push(styler.dim(pad(`· ${state.notice}`, width)));
  push(statusLine(state, width, styler));

  // 硬上限：活动区绝不能高过终端，否则重绘时「上移 N 行」会吃掉已经提交的滚动内容。
  const maxRows = Math.max(3, options.height - 1);
  if (lines.length > maxRows) {
    const drop = lines.length - maxRows;
    lines.splice(0, drop);
    cursor = cursor && cursor.row - drop >= 0 ? { row: cursor.row - drop, col: cursor.col } : null;
  }
  return { lines, cursor };
}

function inputLine(editor: TuiState['editor'], width: number, styler: Styler): { line: string; column: number } {
  const available = Math.max(1, width - 2);
  const { segments, cursorColumn } = scrollEditor(editor, available);
  return { line: `${styler.cyan('> ')}${segments.join('')}`, column: 2 + cursorColumn };
}

function hintLine(state: TuiState): string | undefined {
  if (state.prompt) return undefined;
  if (state.phase === 'menu') return '↑↓ 选择 · Enter 执行 · Esc 取消';
  if (state.phase === 'status') return '任意键返回';
  if (state.phase === 'running') return '运行中 · Esc 中断本轮 · Ctrl+C 退出';
  return 'Enter 发送 · / 命令菜单 · Ctrl+K 全部操作 · Ctrl+C 退出';
}

/** 常驻状态行。先截断纯文本再着色，避免截掉结尾复位序列。 */
function statusLine(state: TuiState, width: number, styler: Styler): string {
  const parts: string[] = [];
  if (state.phase === 'running') parts.push(SPINNER[state.spinner % SPINNER.length]);
  parts.push(state.model);
  parts.push(`审批 ${state.approvalMode}`);
  parts.push(`沙箱 ${state.sandboxMode}`);
  parts.push(`↑${formatTokens(state.usage.prompt)} ↓${formatTokens(state.usage.completion)}`);
  if (state.todo.total > 0) parts.push(`todo ${state.todo.done}/${state.todo.total}`);
  if (state.jobs > 0) parts.push(`jobs ${state.jobs}`);
  if (state.planMode) parts.push('PLAN');
  return styler.dim(truncate(parts.join(' · '), width, '~'));
}

const SPINNER = ['|', '/', '-', '\\'];

/** 滚动区里工具输出最多展示的行数，超出部分折叠成一行提示。 */
const COLLAPSED_TOOL_LINES = 8;

function approvalPanel(
  request: { tool: string; command?: string; path?: string },
  note: string | undefined,
  width: number,
  styler: Styler,
): string[] {
  const out = [truncate(`${styler.yellow('需要审批')} · ${request.tool}`, width, '~')];
  const detail = request.command ?? request.path ?? '';
  for (const line of wrap(detail, Math.max(8, width - 2))) out.push(`  ${styler.dim(line)}`);
  if (note) {
    for (const line of wrap(note, Math.max(8, width - 2))) out.push(`  ${styler.dim(line)}`);
  }
  out.push(styler.dim(truncate('[y] 允许 · [n] 拒绝 · [a] 本会话允许该工具 · Esc 拒绝', width, '~')));
  return out;
}

function askPanel(question: string, width: number, styler: Styler): string[] {
  const out = [truncate(styler.cyan('模型提问'), width, '~')];
  for (const line of wrap(question, Math.max(8, width - 2))) out.push(`  ${line}`);
  out.push(styler.dim(truncate('Enter 回答 · Esc 取消（模型会收到「未回答」）', width, '~')));
  return out;
}

function planPanel(plan: string, width: number, budget: number, styler: Styler): string[] {
  const out = [truncate(styler.magenta('计划待审批'), width, '~')];
  const body = wrap(plan, Math.max(8, width - 2));
  const shown = body.slice(0, budget);
  for (const line of shown) out.push(`  ${line}`);
  if (body.length > shown.length) out.push(styler.dim(`  ... 其余 ${body.length - shown.length} 行`));
  out.push(styler.dim(truncate('[y] 批准并执行 · 输入意见后 Enter 驳回 · Esc 驳回', width, '~')));
  return out;
}

function menuPanel(menu: TuiState['menu'], width: number, budget: number, styler: Styler): string[] {
  if (!menu) return [];
  const rows = Math.max(1, Math.min(budget, menu.items.length));
  const start = Math.max(0, Math.min(menu.index - Math.floor(rows / 2), menu.items.length - rows));
  const header = menu.filter ? `${menu.title} · 过滤「${menu.filter}」` : menu.title;
  const out = [truncate(styler.bold(header), width, '~')];
  if (menu.items.length === 0) {
    out.push(styler.dim('  （无匹配命令）'));
    return out;
  }
  for (let i = start; i < start + rows; i++) {
    const item = menu.items[i];
    const marker = i === menu.index ? '> ' : '  ';
    const label = pad(item.label, 16);
    const line = `${marker}${label}${item.hint}`;
    out.push(i === menu.index ? truncate(styler.cyan(line), width, '') : truncate(line, width, '~'));
  }
  if (menu.items.length > rows) out.push(styler.dim(`  (${menu.index + 1}/${menu.items.length})`));
  return out;
}

function statusPanel(state: TuiState, width: number, styler: Styler): string[] {
  const rows: Array<[string, string]> = [
    ['会话', state.sessionId],
    ['工作区', state.workspaceRoot],
    ['模型', `${state.model} (${state.api}${state.effort ? `, ${state.effort}` : ''})`],
    ['审批', state.approvalMode],
    ['沙箱', `${state.sandboxMode} · ${state.sandboxEnforcement}`],
    ['上下文', `最近一轮输入 ${formatTokens(state.usage.lastPrompt)} / ${formatTokens(state.contextWindow)} tokens`],
    ['用量', `↑${formatTokens(state.usage.prompt)} ↓${formatTokens(state.usage.completion)}`],
    ['TODO', state.todo.total === 0 ? '（空）' : `${state.todo.done}/${state.todo.total}${state.todo.current ? ` · ${state.todo.current}` : ''}`],
    ['后台', `${state.jobs} 个任务`],
    ['MCP', `${state.mcpServers} 个服务 · ${state.mcpTools} 个工具`],
    ['计划模式', state.planMode ? 'on' : 'off'],
  ];
  const out = [styler.bold(truncate('状态', width, '~'))];
  for (const [label, value] of rows) {
    const prefix = `  ${pad(label, 10)}`;
    out.push(truncate(`${prefix}${value}`, width, '~'));
  }
  return out;
}

/** 已提交条目 → 滚动区行。写进终端历史后就不再变，因此可以放心着色与截断。 */
export function renderEntry(entry: TranscriptEntry, options: ViewOptions): string[] {
  const { width, styler } = options;
  switch (entry.kind) {
    case 'user':
      return prefixed('> ', entry.text, width, (text) => styler.cyan(text));
    case 'assistant':
      return wrap(entry.text, width).map((line) => pad(line, width));
    case 'thinking': {
      if (!entry.text) return [];
      const body = wrap(entry.text, Math.max(8, width - 2));
      if (entry.collapsed !== false) {
        const head = body[0] ?? '';
        const extra = body.length > 1 ? ` …（共 ${body.length} 行）` : '';
        return [styler.dim(pad(`[思考] ${head}${extra}`, width))];
      }
      return body.map((line) => styler.dim(pad(`  ${line}`, width)));
    }
    case 'tool': {
      const label = entry.label ?? 'tool';
      const tone = entry.ok === undefined ? styler.dim.bind(styler) : entry.ok ? styler.green.bind(styler) : styler.red.bind(styler);
      const out = [tone(pad(truncate(`[${label}]`, width, '~'), width))];
      const body = wrap(entry.text, Math.max(8, width - 2));
      const shown = body.slice(0, COLLAPSED_TOOL_LINES);
      for (const line of shown) out.push(styler.dim(pad(`  ${line}`, width)));
      if (body.length > shown.length) {
        out.push(styler.dim(pad(`  ... 其余 ${body.length - shown.length} 行`, width)));
      }
      return out;
    }
    case 'notice':
      return [styler.dim(pad(truncate(`· ${entry.text}`, width, '~'), width))];
    case 'error':
      return wrap(entry.text, Math.max(8, width - 2)).map((line, i) =>
        i === 0 ? styler.red(pad(truncate(`! ${line}`, width, '~'), width)) : styler.red(pad(`  ${line}`, width)),
      );
  }
}

function prefixed(
  prefix: string,
  text: string,
  width: number,
  paint: (text: string) => string,
): string[] {
  const body = wrap(text, Math.max(8, width - prefix.length));
  const out: string[] = [];
  body.forEach((line, index) => {
    if (index === 0) out.push(`${paint(prefix)}${line}`);
    else out.push(`${' '.repeat(prefix.length)}${line}`);
  });
  return out.map((line) => pad(line, width));
}

/** 首屏横幅：告诉用户当前落在哪个模型/工作区，以及从哪里开始。 */
export function renderBanner(state: TuiState, options: ViewOptions): string[] {
  const { width, styler } = options;
  const lines = [
    styler.bold('Spring Harness · 交互模式'),
    `模型 ${state.model} · 审批 ${state.approvalMode} · 沙箱 ${state.sandboxMode}`,
    `工作区 ${state.workspaceRoot}`,
    '',
    'Enter 发送 · 输入 / 打开命令菜单 · Ctrl+K 全部操作 · /status 查看状态 · /quit 退出',
  ];
  return lines.map((line) => pad(truncate(line, width, '~'), width));
}
