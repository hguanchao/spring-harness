/**
 * 工具调用分组：把一段连续的工具调用收成一行汇总，形成三级渐进披露——
 * 汇总行（默认）→ 成员一行摘要（双击汇总行）→ 该工具的头尾预览（再双击成员行）。
 *
 * 汇总文案对齐参考实现 grok-build 的 verb-group：动词按时态切换（`Read` / `Reading`）、
 * 名词按数量变单复数（`file` / `files`），按 kind 首次出现的顺序拼成
 * `Read 3 files, Searched 2 patterns`，有失败成员时在尾部追加 ` · N failed`。
 *
 * 思考链（thinking）作为成员并入本组：流式中露一行 `Thinking…`，结束后随组一起折叠，
 * 与参考实现「run claims finished thoughts」同语义。汇总行只统计工具——思考从不进汇总
 * 文案，否则标签会名不副实地描述它藏起来的东西。
 *
 * 分组的边界由调度层决定：出现助手正文、系统提示或轮次结束时断开，
 * 因此「连续调用」在视觉上就是一件事。
 */

import {
  BLOCK_GAP,
  Container,
  Markdown,
  type MarkdownTheme,
  MouseRegion,
  Spacer,
  Text,
  truncateToWidth,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  visibleWidth,
} from '../core/index.js';
import { formatDuration } from '../../util.js';
import { getMarkdownTheme, theme, type ThemeColor } from '../theme/theme.js';
import { DoubleClickTracker } from './interaction.js';
import { TOOL_GROUP_INDENT, TOOL_MARK, TOOL_MEMBER_INDENT, ToolExecutionComponent } from './tool-execution.js';

/** 汇总行用的动词/名词词表（对齐 grok-build 的 VerbGroupKind）。 */
type VerbKind =
  | 'file'
  | 'skill'
  | 'search'
  | 'dir'
  | 'webFetch'
  | 'subagent'
  | 'command'
  | 'edit'
  | 'mcp'
  | 'ask'
  | 'other';

interface VerbWords {
  /** 全部成员都已收尾时用过去式。 */
  past: string;
  /** 还有成员在跑时用进行式。 */
  present: string;
  one: string;
  many: string;
}

const VERB_WORDS: Record<VerbKind, VerbWords> = {
  file: { past: 'Read', present: 'Reading', one: 'file', many: 'files' },
  skill: { past: 'Read', present: 'Reading', one: 'skill', many: 'skills' },
  search: { past: 'Searched', present: 'Searching', one: 'pattern', many: 'patterns' },
  dir: { past: 'Listed', present: 'Listing', one: 'dir', many: 'dirs' },
  webFetch: { past: 'Fetched', present: 'Fetching', one: 'website', many: 'websites' },
  subagent: { past: 'Ran', present: 'Running', one: 'subagent', many: 'subagents' },
  command: { past: 'Ran', present: 'Running', one: 'command', many: 'commands' },
  edit: { past: 'Edited', present: 'Editing', one: 'file', many: 'files' },
  mcp: { past: 'Called', present: 'Calling', one: 'MCP tool', many: 'MCP tools' },
  ask: { past: 'Asked', present: 'Asking', one: 'question', many: 'questions' },
  other: { past: 'Ran', present: 'Running', one: 'tool', many: 'tools' },
};

/**
 * 工具 ID → 词表。
 *
 * skill 单独成词（`Read 2 skills` 与 `Read 2 files` 不同源）；写类工具走 edit；
 * 未登记的工具落进 other——标签只说「Ran N tools」，不编造它做了什么。
 */
const TOOL_VERB_KINDS: Record<string, VerbKind> = {
  read_file: 'file',
  skill: 'skill',
  grep: 'search',
  list_dir: 'dir',
  web_fetch: 'webFetch',
  subagent: 'subagent',
  shell: 'command',
  write: 'edit',
  search_replace: 'edit',
  mcp: 'mcp',
  ask_user: 'ask',
};

interface GroupSummary {
  text: string;
  failed: number;
  running: boolean;
}

/** 按 kind 首次出现的顺序聚合成员，拼出 `Read 3 files, Searched 2 patterns`。 */
function summarize(tools: readonly ToolExecutionComponent[]): GroupSummary {
  const buckets: Array<{ kind: VerbKind; count: number }> = [];
  let failed = 0;
  let running = false;

  for (const tool of tools) {
    const kind = TOOL_VERB_KINDS[tool.rawName()] ?? 'other';
    const bucket = buckets.find((entry) => entry.kind === kind);
    if (bucket) bucket.count += 1;
    else buckets.push({ kind, count: 1 });

    const status = tool.status();
    if (status === 'error') failed += 1;
    if (status === 'pending' || status === 'running') running = true;
  }

  const text = buckets
    .map((bucket) => {
      const words = VERB_WORDS[bucket.kind];
      const verb = running ? words.present : words.past;
      return `${verb} ${bucket.count} ${bucket.count === 1 ? words.one : words.many}`;
    })
    .join(', ');

  return { text, failed, running };
}

export class ToolGroupComponent extends Container {
  private readonly ui: TUI;
  private readonly tools: ToolExecutionComponent[] = [];
  private readonly markdownTheme: MarkdownTheme = getMarkdownTheme();

  private readonly headerText = new Text('', 0, 0);
  private readonly headerRegion: MouseRegion;
  private readonly thinkingText = new Text('', 0, 0);
  private readonly thinkingRegion: MouseRegion;
  private readonly thinkingBody = new Container();
  private readonly body = new Container();
  private readonly headerClick = new DoubleClickTracker();
  private readonly thinkingClick = new DoubleClickTracker();
  private thinkingMarkdown?: Markdown;

  private expanded = false;
  private thinkingExpanded = false;
  private thinking?: { text: string; running: boolean; durationMs?: number };
  /**
   * 脏标记：setter 只标脏，重建推迟到 render(width)。
   *
   * 思考链是逐字增量进来的，每帧可能来十几次 setThinking；立刻重建等于每帧把组件树拆了
   * 重搭一遍。标脏后同一帧内的多次增量只重建一次。
   */
  private dirty = true;
  /** 上次重建用的宽度：汇总行按宽度截断，宽度变了要重算。 */
  private lastWidth = -1;

  constructor(ui: TUI) {
    super();
    this.ui = ui;
    this.headerRegion = new MouseRegion(this.headerText, (event) => this.handleHeaderMouse(event));
    this.thinkingRegion = new MouseRegion(this.thinkingText, (event) => this.handleThinkingMouse(event));
  }

  /** 追加一个工具调用；调用方负责先 setCompact(true)。 */
  addTool(tool: ToolExecutionComponent): void {
    tool.setCompact(true);
    tool.onStateChange = () => {
      this.markDirty();
      this.ui.requestRender();
    };
    this.tools.push(tool);
    this.body.addChild(tool);
    this.markDirty();
  }

  /**
   * 更新思考链成员。running 时 text 是流式累积值，收尾时传权威全文与耗时。
   *
   * 收尾的思考随组折叠（组收起时不占行）——组里没有工具时是例外，那时没有别的行能代表
   * 它，留着才不会让整段推理凭空消失。
   */
  setThinking(text: string, running: boolean, durationMs?: number): void {
    this.thinking = { text, running, durationMs };
    this.markDirty();
    this.ui.requestRender();
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  /** 切换分组展开。默认不打开成员详情——组展开只露一行摘要。 */
  setExpanded(expanded: boolean, expandTools = false): void {
    this.expanded = expanded;
    if (expandTools) {
      for (const tool of this.tools) tool.setExpanded(expanded);
    }
    this.markDirty();
    this.ui.requestRender();
  }

  /** 分组不在渲染树里时（折叠态），正文容器仍要收到失效通知。 */
  override invalidate(): void {
    super.invalidate();
    this.body.invalidate();
    this.thinkingBody.invalidate();
    this.markDirty();
  }

  private markDirty(): void {
    this.dirty = true;
  }

  private handleHeaderMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== 'click' || event.button !== 'left') return undefined;
    if (this.headerClick.accept(event.x, event.y)) {
      // 展开时不动各工具：它们各自的输出仍由双击单独打开。
      this.setExpanded(!this.expanded, false);
    }
    return { handled: true };
  }

  /** 思考行的双击：只开合推理正文，不牵动分组。 */
  private handleThinkingMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== 'click' || event.button !== 'left') return undefined;
    if (this.thinkingClick.accept(event.x, event.y)) {
      this.thinkingExpanded = !this.thinkingExpanded;
      this.markDirty();
      this.ui.requestRender();
    }
    return { handled: true };
  }

  /** 汇总行：字形颜色跟随组状态（有失败→错误色，有成员在跑→accent，否则 dim）。 */
  private updateHeader(summary: GroupSummary, width: number): void {
    const mark = summary.failed > 0 ? TOOL_MARK.fail : summary.running ? TOOL_MARK.running : TOOL_MARK.done;
    const glyphColor: ThemeColor = summary.failed > 0 ? 'error' : summary.running ? 'primary' : 'dim';
    // 超宽时截断而不是折行：汇总行是「一行读一段」，折出来的续行没有字形前缀，读起来像另一条。
    // 失败后缀优先保留——它比多列一个 kind 重要。预算扣掉汇总行左缩进与前缀两列。
    const suffix = summary.failed > 0 ? ` · ${summary.failed} failed` : '';
    const budget = Math.max(1, width - TOOL_GROUP_INDENT - 2 - visibleWidth(suffix));
    const label = truncateToWidth(summary.text, budget, '…');
    let text = `${' '.repeat(TOOL_GROUP_INDENT)}${theme.fg(glyphColor, mark)} ${theme.fg('toolTitle', label)}`;
    if (suffix !== '') text += theme.fg('error', suffix);
    this.headerText.setText(text);
  }

  private updateThinking(): void {
    const state = this.thinking;
    if (!state) return;

    const caret = state.running ? TOOL_MARK.running : TOOL_MARK.done;
    // 收尾文案对齐参考实现：`Thinking…`（进行中）→ `Thought for 1.2s`（已完成）。
    const label = state.running
      ? 'Thinking…'
      : state.durationMs === undefined
        ? 'Thought'
        : `Thought for ${formatDuration(state.durationMs)}`;
    const markColor: ThemeColor = state.running ? 'primary' : 'thinkingText';
    this.thinkingText.setText(
      `${' '.repeat(TOOL_GROUP_INDENT)}${theme.fg(markColor, caret)} ${theme.fg('thinkingText', label)}`,
    );

    this.thinkingBody.clear();
    const detail = state.text.trim();
    if (!this.thinkingExpanded || detail === '') return;
    this.thinkingBody.addChild(new Spacer(1));
    if (this.thinkingMarkdown) {
      this.thinkingMarkdown.setText(detail);
    } else {
      this.thinkingMarkdown = new Markdown(detail, TOOL_MEMBER_INDENT, 0, this.markdownTheme, {
        color: (content: string) => theme.fg('thinkingText', content),
        italic: true,
      });
    }
    this.thinkingBody.addChild(this.thinkingMarkdown);
  }

  /**
   * 重建组件树：统一间距 → 汇总行 → 思考行 → 展开的成员。
   *
   * 思考链**有内容才算成员**：不是所有模型都吐推理内容，但 `thinking_start/end` 在每次
   * LLM 调用前都会广播（`loop.ts`），不过滤就会给每个工具组挂一行永远展开不出东西的
   * `Thought`。运行中但还没有增量时也不占位——输入框上方的状态行已经在说 `Thinking…`。
   *
   * 有内容时，思考行可见的三个条件是：组已展开、思考还在跑、或本组没有工具。前两个保证
   * 「随组折叠」，第三个保证纯思考的组不会渲染成一片空白。汇总行只在有工具时出现。
   */
  private rebuild(width: number): void {
    const thinking = this.thinking;
    const thinkingVisible =
      thinking !== undefined &&
      thinking.text.trim() !== '' &&
      (this.expanded || thinking.running || this.tools.length === 0);

    if (this.tools.length > 0) this.updateHeader(summarize(this.tools), width);
    if (thinkingVisible) this.updateThinking();

    this.clear();
    // 一个成员都渲染不出来时不占位：组可能是 thinking_start 提前开的，那一步既没有工具、
    // 也没有推理内容，留一行空白只会在转录里凿出一个洞。
    if (this.tools.length === 0 && !thinkingVisible) return;
    this.addChild(new Spacer(BLOCK_GAP));
    if (this.tools.length > 0) this.addChild(this.headerRegion);
    if (thinkingVisible) {
      this.addChild(this.thinkingRegion);
      if (this.thinkingExpanded) this.addChild(this.thinkingBody);
    }
    if (this.expanded) this.addChild(this.body);
  }

  override render(width: number): string[] {
    // 同一帧内累积的多次增量在这里合并成一次重建；汇总行的截断依赖宽度，宽度变了也要重算。
    if (this.dirty || this.lastWidth !== width) {
      this.dirty = false;
      this.lastWidth = width;
      this.rebuild(width);
    }
    return super.render(width);
  }
}
