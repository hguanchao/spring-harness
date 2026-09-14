/**
 * 工具调用块：标题行（`>` + 工具名 + 参数摘要）+ 按需详情。
 *
 * 对齐 grok-build 的分层披露：分组展开只露一行成员摘要；再双击该行才出预览。
 * Shell 预览后再双击一次给全文。Read / List / Grep 点开仍是头尾预览，不把整份
 * 内容塞进转录。
 *
 * 前缀按状态：完成 `●`、进行中 `○`、失败 `×`。Subagent 进行中仍用 braille 转圈。
 */

import { Container, MouseRegion, Text, truncateToWidth, type TUI, visibleWidth, wrapTextWithAnsi } from '../core/index.js';
import { flattenWhitespace } from '../../util.js';
import { theme, type ThemeColor } from '../theme/theme.js';
import { DoubleClickTracker } from './interaction.js';
import { subagentTranscriptText, type SubagentHeadParts } from './subagent-task.js';

type ToolStatus = 'pending' | 'running' | 'success' | 'error';

/** 组 / 成员 / 思考 共用的状态前缀：完成实心、进行中空心。 */
export const TOOL_MARK = {
  running: '○',
  done: '●',
  fail: '×',
} as const;

export function toolMark(status: ToolStatus): string {
  if (status === 'error') return TOOL_MARK.fail;
  if (status === 'pending' || status === 'running') return TOOL_MARK.running;
  return TOOL_MARK.done;
}

/** 汇总行左缘，与助手正文 paddingLeft=3 对齐。 */
export const TOOL_GROUP_INDENT = 3;
/** 成员行相对汇总行再缩进，形成下级。 */
export const TOOL_MEMBER_INDENT = 5;
/** 详情相对成员行再缩进，对齐前缀之后的标题列。 */
export const TOOL_DETAIL_INDENT = 8;

function previewWindow(toolName: string): { first: number; last: number } {
  switch (toolName) {
    case 'read_file':
      return { first: 5, last: 3 };
    case 'list_dir':
    case 'grep':
      return { first: 8, last: 4 };
    case 'shell':
      return { first: 2, last: 3 };
    case 'subagent':
      return { first: 12, last: 8 };
    default:
      return { first: 5, last: 3 };
  }
}

/** 按左缩进折行并上色；每行单独着色，避免整块 ANSI 跨行把缩进吃掉。 */
function paintIndented(text: string, width: number, indent: number, paint: (s: string) => string): string {
  const pad = ' '.repeat(indent);
  const inner = Math.max(1, width - indent);
  const lines: string[] = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    for (const wrapped of wrapTextWithAnsi(paint(raw), inner)) lines.push(pad + wrapped);
  }
  return lines.join('\n');
}

export interface ToolResultInput {
  content: string;
  isError: boolean;
}

/**
 * 工具 ID → 界面显示名。
 *
 * 工具 ID 是给模型看的（read_file / search_replace），界面上要的是人一眼能读的短名，
 * 单个工具行与 subagent 活动行用的就是这一列。未登记的工具回落成 ID 本身。
 */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  read_file: 'Read',
  write: 'Write',
  search_replace: 'Edit',
  grep: 'Grep',
  list_dir: 'List',
  shell: 'Bash',
  web_fetch: 'Fetch',
  subagent: 'Subagent',
  todo: 'Todo',
  skill: 'Skill',
  mcp: 'MCP',
  ask_user: 'Ask',
  jobs: 'Job',
};

export function toolDisplayName(toolName: string): string {
  return TOOL_DISPLAY_NAMES[toolName] ?? toolName;
}

export function summarizeArgs(toolName: string, args: Record<string, unknown>): string | undefined {
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    }
    return undefined;
  };
  const oneLine = (value: string | undefined, max = 120): string | undefined => {
    if (value === undefined) return undefined;
    const flat = flattenWhitespace(value);
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  };

  switch (toolName) {
    case 'shell':
      return oneLine(pick('command', 'cmd'));
    case 'read_file':
    case 'write':
    case 'list_dir':
      return oneLine(pick('path', 'file_path', 'filePath'));
    case 'grep':
      return oneLine(pick('pattern', 'query'));
    case 'search_replace':
      return oneLine(pick('path', 'file_path'));
    case 'web_fetch':
      return oneLine(pick('url'));
    // 只取 description：prompt 是整段任务书，回落到它会把一堵墙印进行标题（见 subagent 工具 schema）。
    case 'subagent':
      return oneLine(pick('description'));
    case 'mcp': {
      const server = pick('server');
      const tool = pick('tool');
      return oneLine([server, tool].filter(Boolean).join(' · '));
    }
    case 'skill':
      return oneLine(pick('name', 'skill'));
    case 'todo':
      return oneLine(pick('action', 'status'));
    default:
      return oneLine(pick('path', 'command', 'pattern', 'url', 'query', 'name', 'description'));
  }
}

export class ToolExecutionComponent extends Container {
  private readonly toolName: string;
  private readonly toolCallId: string;
  private args: Record<string, unknown>;
  private result: ToolResultInput | undefined;
  private isPartial = true;
  private started = false;
  /** 成员详情：组展开时仍为 false，只显示一行摘要。 */
  private expanded = false;
  /** Shell 预览后再双击一次为 true，给出全文。 */
  private fullDetail = false;
  /** subagent 调用的元信息：行首的 `Subagent 1 Explore <描述>` 由它拼出。 */
  private subagentMeta: SubagentHeadParts | undefined;
  /** 子代理实时活动（当前动作 / 收尾的 token 与耗时），渲染为标题行的活动后缀。 */
  private activity: { text: string; error: boolean } | undefined;
  /** 子代理的工具调用计数（`List ×16, Read ×4`）：排在活动段之前，宽度不够时最先让位。 */
  private counts: { text: string } | undefined;
  /** 分组内的列表行：未展开时不渲染输出，只留标题行。 */
  private compact = false;
  private readonly ui: TUI;
  private readonly content = new Container();
  private readonly titleText: Text;
  private readonly bodyText: Text;
  private readonly region: MouseRegion;
  private readonly doubleClick = new DoubleClickTracker();
  /** 状态或参数变化时通知分组刷新汇总行。 */
  onStateChange?: () => void;
  /** 标题行（已上色，不含后缀）；按宽度截断，见 updateTitle。 */
  private titleLine = '';
  /** 后缀三段分开存，宽度不够时按「计数 → 行数提示 → 活动」的顺序让位。 */
  private countsLine = '';
  private activityLine = '';
  private hintLine = '';
  private titleDirty = true;
  private titleWidth = -1;
  /** 正文需要按新宽度/新内容重算。 */
  private bodyDirty = true;
  private bodyWidth = -1;

  constructor(toolName: string, toolCallId: string, args: Record<string, unknown>, ui: TUI) {
    super();
    this.toolName = toolName;
    this.toolCallId = toolCallId;
    this.args = args;
    this.ui = ui;

    this.titleText = new Text('', 0, 0);
    this.bodyText = new Text('', 0, 0);
    this.content.addChild(this.titleText);
    this.content.addChild(this.bodyText);
    this.region = new MouseRegion(this.content, (event) => {
      if (event.type !== 'click' || event.button !== 'left') return undefined;
      if (this.doubleClick.accept(event.x, event.y)) this.toggleDetail();
      // 单击也要吃掉：否则同一个 click 会沿布局 box 链继续上冒，判定被重复触发而互相抵消。
      return { handled: true };
    });
    this.addChild(this.region);
    this.updateDisplay();
  }

  get id(): string {
    return this.toolCallId;
  }

  /** 汇总行与标题行共用的短名。 */
  displayName(): string {
    return toolDisplayName(this.toolName);
  }

  /** 原始工具 ID（read_file / grep…）：汇总行按它归动词，显示名（Read / Grep）会丢信息。 */
  rawName(): string {
    return this.toolName;
  }

  updateArgs(args: Record<string, unknown>): void {
    this.args = args;
    this.updateDisplay();
    this.onStateChange?.();
  }

  markExecutionStarted(): void {
    this.started = true;
    this.updateDisplay();
    this.onStateChange?.();
    this.ui.requestRender();
  }

  setArgsComplete(): void {
    this.updateDisplay();
    this.ui.requestRender();
  }

  updateResult(result: ToolResultInput, isPartial = false): void {
    this.result = result;
    this.isPartial = isPartial;
    this.updateDisplay();
    this.onStateChange?.();
    this.ui.requestRender();
  }

  /** 分组折叠成员详情时收回预览；不要用它来打开全文。 */
  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    if (!expanded) this.fullDetail = false;
    this.updateDisplay();
    this.ui.requestRender();
  }

  /**
   * 双击循环：收起 → 预览 →（shell / subagent）全文 → 收起。
   * Read / List / Grep 停在预览，不把整文件/整份清单打进转录。
   */
  toggleDetail(): void {
    if (!this.expanded) {
      this.expanded = true;
      this.fullDetail = false;
    } else if ((this.toolName === 'shell' || this.subagentMeta !== undefined) && !this.fullDetail) {
      this.fullDetail = true;
    } else {
      this.expanded = false;
      this.fullDetail = false;
    }
    this.updateDisplay();
    this.ui.requestRender();
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  /** 分组内的一行：标题行照常，输出只在被双击展开后才出现。 */
  setCompact(compact: boolean): void {
    this.compact = compact;
    this.updateDisplay();
  }

  /** 标记这是 subagent 调用：转录行只留 `Subagent N 描述`，耗时由 setActivity 接上。 */
  attachSubagentMeta(meta: SubagentHeadParts): void {
    this.subagentMeta = meta;
    this.updateDisplay();
    this.ui.requestRender();
  }

  /**
   * 更新子代理实时活动后缀：运行中是当前动作（`Running Grep…`），收尾时是 token 与耗时
   * （`45.2K · 2m13s`）。空文本清除后缀；error 时后缀用错误色——与块状态色无关，
   * 活动失败不代表调用失败。
   */
  setActivity(text: string, error = false): void {
    this.activity = text === '' ? undefined : { text, error };
    this.updateDisplay();
    this.ui.requestRender();
  }

  /**
   * 子代理的工具调用计数（`List ×16, Read ×4`），排在活动段之前。
   * 它是最先被宽度挤掉的一段——计数在展开后的成员行里还能看到，token 与耗时看不到。
   */
  setCounts(text: string): void {
    this.counts = text === '' ? undefined : { text };
    this.updateDisplay();
    this.ui.requestRender();
  }

  hasResult(): boolean {
    return this.result !== undefined;
  }

  status(): ToolStatus {
    if (!this.result) return this.started ? 'running' : 'pending';
    if (this.isPartial) return 'running';
    return this.result.isError ? 'error' : 'success';
  }

  override invalidate(): void {
    super.invalidate();
    this.updateDisplay();
  }

  /** 前缀颜色：失败红、进行中绿、完成灰。 */
  private glyphColor(status: ToolStatus): ThemeColor {
    if (status === 'error') return 'error';
    if (status === 'pending' || status === 'running') return 'primary';
    return 'muted';
  }

  /** 子代理进行中用转圈，其余走 ● / ○ / ×。 */
  private subagentMark(status: ToolStatus): { ch: string; color: ThemeColor } {
    if (this.subagentMeta && (status === 'pending' || status === 'running')) {
      return { ch: '⠏', color: 'primary' };
    }
    return { ch: toolMark(status), color: this.glyphColor(status) };
  }

  /** List 折叠行带 `(N entries)`，与 grok-build 的 List 标题同形。 */
  private listEntrySuffix(): string {
    if (this.toolName !== 'list_dir' || !this.result || this.result.isError) return '';
    const count = this.result.content.split(/\r\n|\r|\n/).filter((line) => line.trim() !== '').length;
    if (count === 0) return '';
    return ` (${count} ${count === 1 ? 'entry' : 'entries'})`;
  }

  /**
   * 宽度无关的部分：标题行的文本与配色。
   *
   * 标题与正文的截断都依赖渲染宽度（折行位置随宽度变化），因此都不在这里做——见 render(width)。
   */
  private updateDisplay(): void {
    const status = this.status();
    const summary = summarizeArgs(this.toolName, this.args);
    // subagent 行首用「序号 + 类型 + 简短描述」，与 dock 里的实时行同一文案；
    // 其余工具保持「显示名 + 参数摘要」；List 额外带 entry 计数。
    const name = this.displayName();
    const title = this.subagentMeta
      ? subagentTranscriptText(this.subagentMeta)
      : `${name}${summary ? ` ${summary}` : ''}${this.listEntrySuffix()}`;
    const activitySuffix = this.activity
      ? this.activity.error
        ? theme.fg('error', ` · ${this.activity.text}`)
        : theme.fg('muted', ` · ${this.activity.text}`)
      : '';
    const mark = this.subagentMark(status);
    const titleColor: ThemeColor = status === 'error' ? 'error' : 'muted';
    this.titleLine = `${theme.fg(mark.color, mark.ch)} ${theme.fg(titleColor, title)}`;
    this.countsLine = this.counts ? theme.fg('muted', ` · ${this.counts.text}`) : '';
    this.activityLine = activitySuffix;
    this.hintLine = '';
    this.titleDirty = true;
    this.bodyDirty = true;
  }

  /**
   * 标题行按真实渲染宽度截断（左缘 TOOL_MEMBER_INDENT，挂在汇总行下级）。
   *
   * 成员行是「一行一个工具」：超宽时截断而不是折行——折出来的续行没有字形前缀，读起来
   * 像另一条工具行。行首是这一行的身份，至少留住一半宽度；后缀按「工具计数 → 行数提示
   * → 活动段」依次让位（计数在展开后的成员行里还能看到，token 与耗时看不到）。
   */
  private updateTitle(width: number): void {
    const available = Math.max(1, width - TOOL_MEMBER_INDENT);
    const titleBudget = Math.min(visibleWidth(this.titleLine), Math.floor(available / 2));
    const room = available - titleBudget;
    let meta = this.countsLine + this.activityLine + this.hintLine;
    if (visibleWidth(meta) > room) meta = this.activityLine + this.hintLine;
    if (visibleWidth(meta) > room) meta = this.activityLine;
    if (visibleWidth(meta) > room) meta = '';
    const head = truncateToWidth(this.titleLine, Math.max(1, available - visibleWidth(meta)), '…');
    this.titleText.setText(`${' '.repeat(TOOL_MEMBER_INDENT)}${head}${meta}`);
  }

  /**
   * 详情按真实宽度折行，左缘 TOOL_DETAIL_INDENT。
   * 组内默认不渲染；双击后给头尾预览，Shell 再双击一次给全文。
   */
  private updateBody(width: number): void {
    const output = this.result?.content?.trim() ?? '';
    if (!output || (this.compact && !this.expanded)) {
      this.bodyText.setText('');
      return;
    }

    const paint = (line: string) =>
      theme.fg(this.result?.isError ? 'error' : 'toolOutput', line);
    if (this.fullDetail || this.result?.isError) {
      this.bodyText.setText(paintIndented(output, width, TOOL_DETAIL_INDENT, paint));
      return;
    }

    const { first, last } = previewWindow(this.toolName);
    const inner = Math.max(1, width - TOOL_DETAIL_INDENT);
    const visual: string[] = [];
    for (const raw of output.split(/\r\n|\r|\n/)) visual.push(...wrapTextWithAnsi(raw, inner));
    const cap = first + last;
    if (visual.length <= cap) {
      this.bodyText.setText(paintIndented(visual.join('\n'), width, TOOL_DETAIL_INDENT, paint));
      return;
    }
    const skipped = visual.length - cap;
    const pad = ' '.repeat(TOOL_DETAIL_INDENT);
    const head = visual.slice(0, first).map((line) => `${pad}${paint(line)}`);
    const tail = visual.slice(-last).map((line) => `${pad}${paint(line)}`);
    const ellipsis = `${pad}${theme.fg('muted', this.toolName === 'shell' && !this.fullDetail ? `… (${skipped} more)` : '…')}`;
    this.bodyText.setText([...head, ellipsis, ...tail].join('\n'));
  }

  override render(width: number): string[] {
    if (this.titleDirty || this.titleWidth !== width) {
      this.titleDirty = false;
      this.titleWidth = width;
      this.updateTitle(width);
    }
    if (this.bodyDirty || this.bodyWidth !== width) {
      this.bodyDirty = false;
      this.bodyWidth = width;
      this.updateBody(width);
    }
    return super.render(width);
  }
}
