/**
 * 工具调用分组：把一段连续的工具调用收成一行汇总，形成三级渐进披露——
 * 汇总行（默认）→ 成员一行摘要（双击汇总行）→ 该工具的头尾预览（再双击成员行）。
 *
 * 汇总文案：动词按时态切换（`Read` / `Reading`）、
 * 名词按数量变单复数（`file` / `files`），按 kind 首次出现的顺序拼成
 * `Read 3 files, Searched 2 patterns`，有失败成员时在尾部追加 ` · N failed`。
 *
 * 思考链（thinking）作为成员并入本组：流式中露一行 `Thinking…`，结束后随组一起折叠，
 * 与参考实现「run claims finished thoughts」同语义。**一次 LLM 调用一段**，同一组可以有多段
 * （组只在助手正文处断开，所以一次 run 常跨多个迭代），各段按发生顺序与工具行交错排列、
 * 互不覆盖。汇总行只统计工具——思考从不进汇总文案，否则标签会名不副实地描述它藏起来的东西。
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
  VStack,
} from '../../../tui/index.js';
import { formatDuration } from '../../../util.js';
import { theme, type ThemeColor } from '../theme/theme.js';
import { DoubleClickTracker } from './interaction.js';
import { armHoverHighlight } from './hover-highlight.js';
import { asSelectableRow, handleSelectablePress } from './selectable-row.js';
import {
  TOOL_DETAIL_INDENT,
  TOOL_GROUP_INDENT,
  TOOL_MARK,
  TOOL_MEMBER_INDENT,
  type ToolExecutionComponent,
} from './tool-execution.js';

/** 扫光心跳周期：与状态行 Loader / 子代理行的转圈帧同拍（80ms）。 */
const SHIMMER_TICK_MS = 80;

/** 汇总行用的动词/名词词表。 */
type VerbKind =
  | 'file'
  | 'skill'
  | 'search'
  | 'dir'
  | 'webSearch'
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
  webSearch: { past: 'Searched', present: 'Searching', one: 'web query', many: 'web queries' },
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
  read: 'file',
  skill: 'skill',
  grep: 'search',
  glob: 'search',
  ls: 'dir',
  web_search: 'webSearch',
  web_fetch: 'webSearch',
  subagent: 'subagent',
  bash: 'command',
  pwsh: 'command',
  write: 'edit',
  edit: 'edit',
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

/**
 * 组内一段思考。同一组可以有多段——每次 LLM 调用一份，按发生顺序与工具行交错排列。
 *
 * 每段自带展开态：双击标题或详情都只开合这一段正文，不牵动分组、也不牵动别的思考段。
 */
class ThinkingMember {
  text = '';
  running = true;
  durationMs: number | undefined;
  expanded = false;
  /** 正文当前挂的缩进档位；组开/合会改变它，变了就要重建 Markdown。 */
  bodyIndent = TOOL_DETAIL_INDENT;
  readonly row = new Text('', 0, 0);
  readonly body = new Container();
  /**
   * 标题行 + 详情共处一块：双击详情也要能收起。
   * 旧实现 region 只包标题，正文是旁边的独立节点——详情一长，标题滚出视口后
   * 就只能滚回去点 Thinking 才能折上。
   */
  readonly block = new Container();
  readonly region: MouseRegion;
  readonly click = new DoubleClickTracker();
  markdown?: Markdown;

  constructor(onToggle: (self: ThinkingMember, event: TuiMouseEvent) => TuiMouseEventResult | undefined) {
    this.block.addChild(this.row);
    this.block.addChild(this.body);
    this.region = asSelectableRow(new MouseRegion(this.block, (event) => onToggle(this, event)));
  }
}

/** 组内成员：思考段或工具行，按发生顺序排列。 */
type GroupMember =
  | { kind: 'thinking'; thinking: ThinkingMember }
  | { kind: 'tool'; tool: ToolExecutionComponent };

let grayThinkingTheme: MarkdownTheme | undefined;

/**
 * 思考正文专用主题：**一切元素压成中性灰**（toolTitle）。
 *
 * 思考内容是 markdown——复用全局主题时，里面的标题/列表序号/行内码会吃到紫与蓝，
 * 而推理记录应当整体退到背景层。粗体/斜体保留字形，颜色统一灰。
 */
function thinkingMarkdownTheme(): MarkdownTheme {
  if (grayThinkingTheme) return grayThinkingTheme;
  const gray = (text: string): string => theme.fg('toolTitle', text);
  grayThinkingTheme = {
    heading: gray,
    link: gray,
    linkUrl: gray,
    code: gray,
    codeBlock: gray,
    codeBlockBorder: gray,
    quote: gray,
    quoteBorder: gray,
    hr: gray,
    listBullet: gray,
    bold: (text) => theme.bold(gray(text)),
    italic: (text) => theme.italic(gray(text)),
    emphasis: (text) => theme.italic(gray(text)),
    underline: gray,
    strikethrough: gray,
  };
  return grayThinkingTheme;
}

export class ToolGroupComponent extends VStack {
  private readonly ui: TUI;
  private readonly tools: ToolExecutionComponent[] = [];
  /**
   * 有序成员表：思考段与工具行按真实发生顺序交错。
   *
   * 旧实现只存一个 thinking 槽位，`setThinking` 直接覆盖——同一组跨多个迭代时
   * （组只在助手正文处断开），只有最后一份思考活下来。改成有序表后每段各留其位。
   */
  private readonly members: GroupMember[] = [];
  /** 当前正在流式写入的那一段；收尾后置空由下一次 beginThinking 另起。 */
  private currentThinking?: ThinkingMember;

  private readonly headerText = new Text('', 0, 0);
  private readonly headerRegion: MouseRegion;
  private readonly headerClick = new DoubleClickTracker();

  private expanded = false;
  /**
   * 脏标记：setter 只标脏，重建推迟到 render(width)。
   *
   * 思考链是逐字增量进来的，每帧可能来十几次 setThinking；立刻重建等于每帧把组件树拆了
   * 重搭一遍。标脏后同一帧内的多次增量只重建一次。
   */
  private dirty = true;
  /** 上次重建用的宽度：汇总行按宽度截断，宽度变了要重算。 */
  private lastWidth = -1;
  /** 扫光心跳：仅组内存活成员期间运转，见 pumpAnimation。 */
  private animTimer?: ReturnType<typeof setInterval>;

  constructor(ui: TUI) {
    super();
    this.ui = ui;
    this.headerRegion = asSelectableRow(new MouseRegion(this.headerText, (event) => this.handleHeaderMouse(event)));
  }

  /**
   * 扫光心跳的驱动。转录行活在 ScrollView 的内容缓存后面：转圈/子代理 dock 行的
   * 心跳走视口通道（不 bump contentGeneration），刷得到 dock 却刷不到这里——表现为
   * 扫光冻结，只有双击这类完整渲染才走一帧。存活期间自走完整渲染通道，组收尾自停。
   */
  private pumpAnimation(live: boolean): void {
    if (live && this.animTimer === undefined) {
      this.animTimer = setInterval(() => {
        // tick 里复查 isLive：组收尾即自停，不让定时器空转挂进程。
        if (this.isLive()) this.ui.requestRender();
        else this.stopAnimation();
      }, SHIMMER_TICK_MS);
      this.animTimer.unref?.();
    } else if (!live) {
      this.stopAnimation();
    }
  }

  private stopAnimation(): void {
    if (this.animTimer !== undefined) {
      clearInterval(this.animTimer);
      this.animTimer = undefined;
    }
  }

  /** 追加一个工具调用；调用方负责先 setCompact(true)。 */
  addTool(tool: ToolExecutionComponent): void {
    tool.setCompact(true);
    tool.onStateChange = () => {
      this.markDirty();
      this.ui.requestRender();
    };
    this.tools.push(tool);
    this.members.push({ kind: 'tool', tool });
    this.markDirty();
  }

  /** 新开一段思考（每次 LLM 调用一份）。同一组内多段按发生顺序保留，互不覆盖。 */
  beginThinking(): void {
    this.startThinking();
    this.markDirty();
    this.ui.requestRender();
  }

  private startThinking(): ThinkingMember {
    const thinking = new ThinkingMember((self, event) => this.handleThinkingMouse(self, event));
    this.members.push({ kind: 'thinking', thinking });
    this.currentThinking = thinking;
    return thinking;
  }

  /**
   * 更新当前思考段。running 时 text 是流式累积值，收尾时传权威全文与耗时。
   *
   * 收尾的思考随组折叠（组收起时不占行）——组里没有工具时是例外，那时没有别的行能代表
   * 它，留着才不会让整段推理凭空消失。
   */
  /** 传输重试：丢掉当前思考段（含尚未吐字的占位），不进最终转录。 */
  dropStreamingThinking(): void {
    if (!this.currentThinking) return;
    const index = this.members.findLastIndex(
      (member) => member.kind === 'thinking' && member.thinking === this.currentThinking,
    );
    if (index >= 0) this.members.splice(index, 1);
    this.currentThinking = undefined;
    this.markDirty();
    this.ui.requestRender();
  }

  setThinking(text: string, running: boolean, durationMs?: number): void {
    // 没先 beginThinking 就更新（旧调用序）时补一段，别把已经流出的增量丢掉。
    const thinking = this.currentThinking ?? this.startThinking();
    thinking.text = text;
    thinking.running = running;
    thinking.durationMs = durationMs;
    this.markDirty();
    // 思考段在转录 ScrollView 里：必须 bump contentGeneration，视口通道会命中
    // 滚动缓存、增量看不见。listener 同帧也会 requestRender，框架会合并。
    this.ui.requestRender();
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  /**
   * 切换分组展开。收起时把下级详情一并复位：工具正文与思考正文都收回，
   * 重新展开组是干净的折叠列表，不会冒出上次留下的展开态。
   * expandTools 仅用于展开侧（折叠时复位是本函数的本职，与该参数无关）。
   */
  setExpanded(expanded: boolean, expandTools = false): void {
    this.expanded = expanded;
    if (expanded) {
      if (expandTools) {
        for (const tool of this.tools) tool.setExpanded(true);
      }
    } else {
      for (const tool of this.tools) tool.setExpanded(false);
      for (const entry of this.members) {
        if (entry.kind === 'thinking') entry.thinking.expanded = false;
      }
    }
    this.markDirty();
    this.ui.requestRender();
  }

  /** 分组不在渲染树里时（折叠态），成员仍要收到失效通知。 */
  override invalidate(): void {
    super.invalidate();
    for (const tool of this.tools) tool.invalidate();
    for (const member of this.members) {
      if (member.kind !== 'thinking') continue;
      member.thinking.row.invalidate();
      member.thinking.body.invalidate();
    }
    this.markDirty();
  }

  private markDirty(): void {
    this.dirty = true;
  }

  private headerHovered = false;

  /** 悬停高亮：汇总行整行铺浅底（与挂起条悬停同一极浅色）。返回是否有变化。 */
  private setHeaderHovered(on: boolean): boolean {
    if (this.headerHovered === on) return false;
    this.headerHovered = on;
    this.headerText.setCustomBgFn(on ? (text) => theme.bg('steerHoverBg', text) : undefined);
    return true;
  }

  private handleHeaderMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // 悬停高亮：汇总行铺浅底。移出的清除由 TUI.onMouseMotion 先行（先清后亮）。
    if (event.type === 'move' && this.setHeaderHovered(true)) {
      armHoverHighlight(() => this.setHeaderHovered(false));
      this.ui.requestRender();
    }
    if (event.button !== 'left') return undefined;
    const press = handleSelectablePress(this.headerRegion, event);
    if (press) return press;
    if (event.type !== 'click') return undefined;
    if (this.headerClick.accept(event.x, event.y)) {
      // 展开时不动各工具：它们各自的输出仍由双击单独打开。
      this.setExpanded(!this.expanded, false);
    }
    return { handled: true };
  }

  /** 思考行的双击：只开合这一段推理的正文，不牵动分组、也不牵动别的思考段。 */
  private handleThinkingMouse(
    member: ThinkingMember,
    event: TuiMouseEvent,
  ): TuiMouseEventResult | undefined {
    if (event.button !== 'left') return undefined;
    // 分行路由（y 为成员块内行号，0 = 标题行），与工具行同一套约定：
    // - 标题行按压：钉行（❙ 标记）并接管——双击开合的触发面。
    // - 正文行按压：放行给全屏划词——推理正文才是要拖动复制的内容。
    //   正文上的双击会经「原位松开合成 click」回到这里，同样计开合（收起）。
    if (event.type === 'press') {
      if (event.y !== 0) return undefined;
      const press = handleSelectablePress(member.region, event);
      if (press) return press;
    }
    if (event.type !== 'click') return undefined;
    if (member.click.accept(event.x, event.y)) {
      member.expanded = !member.expanded;
      this.markDirty();
      this.ui.requestRender();
    }
    return { handled: true };
  }

  /**
   * 汇总行：字形颜色与行文同一套——有失败→错误色，否则随文字 toolTitle 灰。
   * 箭头表达组开合（`▸`/`▾`）。汇总行和它下面的成员行是同一个视觉块，
   * 两边配色不一致会让「跑完」看起来像换了半屏颜色。
   */
  private updateHeader(summary: GroupSummary, width: number): void {
    // 箭头只表达「可展开/已展开」，颜色跟汇总行文字（toolTitle）走；失败仍整行用 error 后缀示警。
    const mark = summary.failed > 0 ? TOOL_MARK.fail : this.expanded ? TOOL_MARK.expanded : TOOL_MARK.done;
    const glyphColor: ThemeColor = summary.failed > 0 ? 'error' : 'toolTitle';
    // 超宽时截断而不是折行：汇总行是「一行读一段」，折出来的续行没有字形前缀，读起来像另一条。
    // 失败后缀优先保留——它比多列一个 kind 重要。预算扣掉汇总行左缩进与前缀两列。
    const suffix = summary.failed > 0 ? ` · ${summary.failed} failed` : '';
    const budget = Math.max(1, width - TOOL_GROUP_INDENT - 2 - visibleWidth(suffix));
    const label = truncateToWidth(summary.text, budget, '…');
    const painted = summary.running ? theme.shimmer(label, Date.now()) : theme.fg('toolTitle', label);
    let text = `${' '.repeat(TOOL_GROUP_INDENT)}${theme.fg(glyphColor, mark)} ${painted}`;
    if (suffix !== '') text += theme.fg('error', suffix);
    this.headerText.setText(text);
  }

  /** 重算一段思考的行文案；正文只在它自己展开时挂上。 */
  private updateThinking(member: ThinkingMember): void {
    // 箭头只表达展开态；颜色跟标签文字，与成员行/汇总行同一套「灰箭头灰字」。
    const caret = member.expanded ? TOOL_MARK.expanded : TOOL_MARK.done;
    // 收尾文案：`Thinking…`（进行中）→ `Thought for 1.2s`（已完成）。空链不占行。
    const label = member.running
      ? 'Thinking…'
      : member.durationMs === undefined
        ? 'Thought'
        : `Thought for ${formatDuration(member.durationMs)}`;
    // 标签文字才是状态色：执行中紫、完成后灰。
    const labelColor: ThemeColor = member.running ? 'primary' : 'toolTitle';
    // 组里有汇总行时，思考永远是成员：缩进一级，避免和汇总行并排读成两件并列的事。
    // 纯思考组没有汇总行，思考行就是组头，仍停在组级。
    const rowIndent = this.tools.length > 0 ? TOOL_MEMBER_INDENT : TOOL_GROUP_INDENT;
    const painted = member.running ? theme.shimmer(label, Date.now()) : theme.fg(labelColor, label);
    member.row.setText(
      `${' '.repeat(rowIndent)}${theme.fg(labelColor, caret)} ${painted}`,
    );

    member.body.clear();
    const detail = member.text.trim();
    if (!member.expanded || detail === '') return;
    // 正文跟随自己的行：行缩进 +2（对齐标签列）。组开/合会改变档位，
    // Markdown 的 paddingX 建后不可变，档位变了就重建。
    const bodyIndent = rowIndent + 2;
    if (member.markdown && member.bodyIndent !== bodyIndent) member.markdown = undefined;
    if (member.markdown) {
      member.markdown.setText(detail);
    } else {
      member.markdown = new Markdown(detail, bodyIndent, 0, thinkingMarkdownTheme(), {
        color: (content: string) => theme.fg('toolTitle', content),
        italic: true,
      });
      member.bodyIndent = bodyIndent;
    }
    member.body.addChild(member.markdown);
  }

  /**
   * 重建组件树：统一间距 → 汇总行 → 思考行 → 展开的成员。
   *
   * 思考段**有内容才占行**：空链（很多端点不吐 reasoning）不画「思考结束」。
   * 运行中但还没有增量时也不占位。有内容时随组折叠；组里没有工具时纯思考行必须可见。
   */
  private rebuild(width: number): void {
    const visible = (member: ThinkingMember): boolean =>
      member.text.trim() !== '' && (this.expanded || member.running || this.tools.length === 0);
    const thinkings = this.members.flatMap((entry) => (entry.kind === 'thinking' ? [entry.thinking] : []));
    const anyThinkingVisible = thinkings.some(visible);

    if (this.tools.length > 0) this.updateHeader(summarize(this.tools), width);
    for (const member of thinkings) {
      if (visible(member)) this.updateThinking(member);
    }

    this.clear();
    // 一个成员都渲染不出来时不占位：组可能是 thinking_start 提前开的，那一步既没有工具、
    // 也没有推理内容，留一行空白只会在转录里凿出一个洞。
    if (this.tools.length === 0 && !anyThinkingVisible) return;
    this.addChild(new Spacer(BLOCK_GAP));
    if (this.tools.length > 0) this.addChild(this.headerRegion);
    // 按发生顺序交错：思考段与工具行各留其位，不再把思考全堆在工具列表之前。
    for (const entry of this.members) {
      if (entry.kind === 'thinking') {
        if (!visible(entry.thinking)) continue;
        this.addChild(entry.thinking.region);
        continue;
      }
      if (this.expanded) this.addChild(entry.tool);
    }
  }

  override render(width: number): string[] {
    // 进行中的组每帧重画标签扫光；其余仍合并脏标记，避免空闲时拆树。
    const live = this.isLive();
    this.pumpAnimation(live);
    if (live || this.dirty || this.lastWidth !== width) {
      this.dirty = false;
      this.lastWidth = width;
      this.rebuild(width);
    }
    return super.render(width);
  }

  private isLive(): boolean {
    if (this.tools.some((tool) => {
      const status = tool.status();
      return status === 'pending' || status === 'running';
    })) return true;
    return this.members.some((entry) => entry.kind === 'thinking' && entry.thinking.running);
  }
}
