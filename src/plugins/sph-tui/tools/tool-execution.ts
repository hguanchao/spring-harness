/**
 * 工具调用块：标题行（`>` + 工具名 + 参数摘要）+ 按需详情。
 *
 * 分层披露：分组展开只露一行成员摘要；再双击该行才出预览。
 * Shell 预览后再双击一次给全文。Read / List / Grep 点开仍是头尾预览，不把整份
 * 内容塞进转录。edit / write 成功后，组一展开就在行下给出短 diff，双击再放长。
 *
 * 前缀按状态：进行中/完成 `›`、展开 `✦`、失败 `×`；进行中的标题带 shimmer。
 * 行内不用 braille 转圈——那个字形在 Windows 终端常见字体里缺字，会退化成别的符号。
 * 展开后的详情块整块挂在一条竖轨（`│`）上：轨与标题前缀同列，内容对齐详情缩进，
 * 和 Claude Code / Codex 的工具输出同款——详情看一眼就知道属于上面的哪一行。
 */

import {
  Container,
  DoubleClickTracker,
  MouseRegion,
  SUPPRESS_MULTI_CLICK_SELECTION,
  Text,
  truncateToWidth,
  type TUI,
  visibleWidth,
  wrapTextWithAnsi,
} from '@/tui/index.js';
import { flattenWhitespace } from '@/util.js';
import { theme, type ThemeColor } from '@/plugins/sph-tui/theme/theme.js';
import { failureHeadline, WorkingLabel } from '@/plugins/sph-tui/interaction/index.js';
import { armHoverHighlight } from '@/plugins/sph-tui/interaction/hover-highlight.js';
import { rowChromeBg, selectTranscriptRow } from '@/plugins/sph-tui/interaction/row-selection.js';
import { handleSelectablePress, SELECTABLE_ROW } from '@/plugins/sph-tui/interaction/selectable-row.js';
import { type SubagentHeadParts } from '@/plugins/sph-tui/tools/subagent-task.js';
import { languageForDiffHeader, languageForPath, syntaxSpans } from '@/plugins/sph-tui/tools/diff-syntax.js';
import {
  DIFF_EXPANDED_LINES,
  DIFF_PREVIEW_LINES,
  DIFF_LINE_NUMBERS,
  diffLineNumbers,
  fileChangeFromArgs,
  looksLikeUnifiedDiff,
  matchLineFromResult,
  singleLineNumber,
  unifiedDiffLineKind,
  type FileChange,
  type UnifiedDiffLineKind,
} from '@/plugins/sph-tui/tools/tool-diff.js';

type ToolStatus = 'pending' | 'running' | 'success' | 'error';

/**
 * 组头/成员行用 `›`（未展开）与 `✦`（展开）表达开合。全项目只有这一对：报告面板的折叠字形
 * （`FOLD_MARK`）与它是同一对，别处不要再造第三种「开合」。
 * 成员行完成未展开时用 `›`，和进行中同字形，靠标题 shimmer 停下来区分；展开后用 `✦`。
 * 失败仍用 `×`。
 */
export const TOOL_MARK = {
  running: '›',
  done: '›',
  settled: '›',
  expanded: '✦',
  fail: '×',
} as const;

/**
 * 思考行前缀：进行中空心 `✧`、收尾实心 `✦`，与 Recap 同态。
 *
 * `✦` 在这里与工具行的展开（{@link TOOL_MARK} 的 `expanded`）合流：都读「这一行有结果了、
 * 内容露出来了」；`✧` 则是全项目唯一的「进行中」。两个字形可见宽度都是 1，折行悬挂缩进不受
 * 影响（{@link TOOL_MEMBER_INDENT} 按 `X ` 两列算）。
 */
export const THOUGHT_MARK = {
  running: '✧',
  done: '✦',
} as const;

export function toolMark(status: ToolStatus, expanded = false): string {
  if (status === 'error') return TOOL_MARK.fail;
  if (expanded) return TOOL_MARK.expanded;
  if (status === 'pending' || status === 'running') return TOOL_MARK.running;
  return TOOL_MARK.settled;
}

/** 汇总行左缘，与助手正文 paddingLeft=3 对齐。 */
export const TOOL_GROUP_INDENT = 3;
/** 成员行相对汇总行再缩进，形成下级。 */
export const TOOL_MEMBER_INDENT = 5;
/** 详情相对成员行再缩进，对齐前缀之后的标题列。 */
export const TOOL_DETAIL_INDENT = 8;

/**
 * 详情块每行的左缘：竖轨 `│` 落在成员行前缀（`›`/`✦`）同一列，轨后的空格把内容
 * 顶到 TOOL_DETAIL_INDENT——可见宽度与纯缩进一致，折行宽度计算不用跟着变。
 */
function detailRailPad(): string {
  const railColumns = TOOL_DETAIL_INDENT - TOOL_MEMBER_INDENT - 1;
  return `${' '.repeat(TOOL_MEMBER_INDENT)}${theme.fg('muted', '│')}${' '.repeat(railColumns)}`;
}

/**
 * 折叠预览的窗口：头部行数 + 尾部行数，`…` 夹在中间。
 *
 * 这两组数字数的是**内容行**（见 previewContentLines），信封与空行不占预算。
 * shell 给 4 行头（`exit`/`stdout:` 剥掉后才是真输出）、read 给 5 行。
 */
function previewWindow(toolName: string): { first: number; last: number } {
  switch (toolName) {
    case 'read':
      return { first: 5, last: 3 };
    case 'ls':
    case 'grep':
      return { first: 8, last: 4 };
    case 'bash':
    case 'pwsh':
      return { first: 4, last: 3 };
    case 'subagent':
      return { first: 12, last: 8 };
    default:
      return { first: 5, last: 3 };
  }
}

/**
 * 工具输出里真正值得占窗口的行：剥掉信封，再丢掉空行。
 *
 * 两种信封都不是内容，却和内容抢同一份窗口预算：
 * - `read` 的正文首行是工作区相对路径（工具行标题里已经写了一遍）；
 * - `bash` / `pwsh` 的正文前两行固定是 `exit N` 与 `stdout:`，stderr 段前还有一条 `stderr:`。
 *
 * 曾经它们把预算吃掉一大截：read 头部 5 行里只看到 4 行源码（第 5 行掉进 `…`），
 * 而 shell 的头部 2 行恰好是 `exit 0` + `stdout:`——一行真实输出都没有。
 *
 * 空行同样要丢，而且 read 的空行是带行号的（`   2|`），不能只看整行是否为空：
 * README 头部 5 行里有 2 行是空行，`…` 于是出现在正文第 4 行，文件真正写的内容一行没露。
 * 行号本身把「这里跳过了一行」记录下来，占一整行却不给信息的空行不值得占窗口。
 */
function previewContentLines(toolName: string, output: string): string[] {
  const lines = output.split(/\r\n|\r|\n/);
  if (toolName === 'read' && lines.length > 1 && !/^\s*\d+\|/.test(lines[0] ?? '')) lines.shift();
  if (toolName === 'bash' || toolName === 'pwsh') {
    if (/^exit \S+$/.test((lines[0] ?? '').trim())) lines.shift();
    if (/^stdout:/.test((lines[0] ?? '').trim())) lines.shift();
  }
  return lines.filter((line) => {
    const numbered = /^\s*\d+\|(.*)$/.exec(line);
    return (numbered?.[1] ?? line).trim() !== '';
  });
}

/** 行号列宽度（`   3|` 占 5 列）；没有行号的行返回 0。 */
function hangingIndent(raw: string): number {
  return /^\s*\d+\|/.exec(raw)?.[0].length ?? 0;
}

/**
 * 按宽度折行，并给续行留悬挂缩进。
 *
 * `read` 的行长这样：`   3|xAI …（很长的一句话）`。续行不缩进就顶到竖轨上，读起来像另一行内容，
 * 上一行反而被当成完整的一句。行号列是固定宽度（工具里 padStart(4) 加一个 `|`），
 * 所以续行对齐到它的右边即可——和正文首字同一列。
 *
 * 缩进是从折行宽度里**扣**出来的，不是折完再补：补出来的续行会比可用宽度多出缩进那几列，
 * 外层按宽度一裁，尾巴就没了。
 *
 * 折行器在第一段就是个超宽词时会先吐一个只含空白的行（行首缩进被 trimEnd 成空串），
 * 详情块里那会变成一条只有竖轨的空行；预览行本来就都带内容，空行一律当噪音丢掉。
 */
function wrapIndented(raw: string, inner: number): string[] {
  // 空行留着：它是 diff 里的一行（有自己的行号和底色），丢了会读成行号跳号。
  if (raw.trim() === '') return [raw];
  const indent = Math.min(hangingIndent(raw), Math.max(0, inner - 1));
  const wrapped = wrapTextWithAnsi(raw, Math.max(1, inner - indent)).filter((line) => line !== '');
  if (indent === 0 || wrapped.length <= 1) return wrapped;
  return [wrapped[0]!, ...wrapped.slice(1).map((line) => `${' '.repeat(indent)}${line}`)];
}

/**
 * 行号栏：号码右对齐，后接一个空格进正文。
 *
 * 形态由 {@link DIFF_LINE_NUMBERS} 定：**单列**（默认）只显示相关的那一侧——删显旧号、
 * 加与上下文显新号，省四列；双列（旧|新）无歧义但要宽度。两种形态下栏宽都是定值，
 * `cell(index)` 返回该行的号码格（含填充，未上色），折行续行与 `… (N more)` 用等宽空格对齐；
 * 竖轨由调用方另上灰，免得跟着增删色一起红/绿。
 */
function lineNumberGutter(entries: readonly { old?: number; new?: number }[]): {
  cell: (index: number) => string;
  width: number;
} {
  const numbers: { old?: number; new?: number }[] = DIFF_LINE_NUMBERS === 'single'
    ? entries.map((entry) => ({ new: singleLineNumber(entry) }))
    : entries.map((entry) => ({ old: entry.old, new: entry.new }));
  const widest = (pick: (entry: { old?: number; new?: number }) => number | undefined): number =>
    numbers.reduce((max, entry) => Math.max(max, String(pick(entry) ?? '').length), 0);
  const oldWidth = DIFF_LINE_NUMBERS === 'single' ? 0 : widest((entry) => entry.old);
  const newWidth = widest((entry) => entry.new);
  const numberWidth = oldWidth + newWidth === 0 ? 0 : oldWidth + (oldWidth === 0 ? 0 : 1) + newWidth;
  // 栏宽 = 号码格 + 一个空格。算错一格，折行与 `… (N more)` 就会错位。
  const width = numberWidth === 0 ? 0 : numberWidth + 1;
  const cell = (value: number | undefined, column: number): string => String(value ?? '').padStart(column);
  return {
    width,
    cell: (index: number): string => {
      if (numberWidth === 0) return '';
      const entry = numbers[index] ?? {};
      return oldWidth === 0
        ? cell(entry.new, newWidth)
        : `${cell(entry.old, oldWidth)} ${cell(entry.new, newWidth)}`;
    },
  };
}

/** 行首栏：号码按增删/上下文上色，后接一个空格再进正文。栏不铺底色，宽度为 0 时不画栏。 */
function numberLead(cell: string, color: ThemeColor, gutterWidth: number): string {
  return gutterWidth === 0 ? '' : `${theme.fg(color, cell)} `;
}

/** 折行续行与空号行的栏：等宽空格，不上色。 */
function blankLead(gutterWidth: number): string {
  return ' '.repeat(gutterWidth);
}

/**
 * 一行的内容部分。底色已在行首栏起笔（numberLead / blankLead），这里只负责把正文
 * 铺到内容区宽度、再补 `49m` 收尾——不收尾底色会渗到下一行（框内的行没有自己的底色）。
 */
/** 语法高亮后的行：片段已带前景色（每段自闭合），paintedBody 只负责铺带、垫宽与收尾。 */
/** prePainted 行的整行组装：底色从**内容区**起笔，行号槽留在画布底（grok 的实际形态）。 */
function paintedBody(text: string, paint: { band: string; content: ThemeColor }, inner: number, prePainted = false): string {
  if (prePainted) {
    if (paint.band === '') return text;
    return `${paint.band}${text}${' '.repeat(Math.max(0, inner - visibleWidth(text)))}\x1b[49m`;
  }
  if (paint.band === '') return theme.fg(paint.content, text);
  const padded = text + ' '.repeat(Math.max(0, inner - visibleWidth(text)));
  return `${paint.band}${theme.fg(paint.content, padded)}\x1b[49m`;
}

/** 一条源行摊成若干可见行：折行的续行保持同一档色与等宽空栏，不掉号也不变灰。 */
export interface DiffBodyRow {
  text: string;
  paint: { band: string; number: ThemeColor; content: ThemeColor };
  lead: string;
  /** text 已是语法高亮过的整行（片段自带前景色），paintedBody 不再整行套 fg。 */
  prePainted?: boolean;
}

function diffBodyRows(
  source: string,
  kind: UnifiedDiffLineKind,
  index: number,
  gutter: { cell: (position: number) => string; width: number },
  inner: number,
  lang?: string,
): DiffBodyRow[] {
  const paint = diffPaint(kind);
  // 语法高亮在折行**前**做：tokenize 认的是源码，折完的残句会高亮错。
  // wrapTextWithAnsi 感知 ANSI，折出的续行自动带上仍活跃的前景序列。
  let painted: string | undefined;
  if (lang && kind !== 'hunk' && kind !== 'meta' && source.trim() !== '') {
    const spans = syntaxSpans(source, lang);
    if (spans.some((span) => span.color !== 'text')) {
      painted = spans
        .map(({ text, color, italic }) =>
          color === 'text' ? text : italic ? `\x1b[3m${theme.fg(color, text)}\x1b[23m` : theme.fg(color, text))
        .join('');
    }
  }
  return wrapIndented(painted ?? source, inner).map((text, position) => ({
    text,
    paint,
    prePainted: painted !== undefined || undefined,
    lead:
      position === 0
        ? numberLead(gutter.cell(index), paint.number, gutter.width)
        : blankLead(gutter.width),
  }));
}

/** 增删行的两组颜色：底色（空 = 这一档画不出底色）与内容色。 */
function diffPaint(kind: UnifiedDiffLineKind): { band: string; number: ThemeColor; content: ThemeColor } {
  if (kind === 'hunk') return { band: '', number: 'primary', content: 'primary' };
  if (kind === 'meta') return { band: '', number: 'muted', content: 'toolOutput' };
  const accent: ThemeColor = kind === 'add' ? 'success' : kind === 'del' ? 'error' : 'muted';
  const role = kind === 'add' ? 'diffAddBg' : kind === 'del' ? 'diffDelBg' : undefined;
  const band = role === undefined ? '' : theme.bgSeq(role as ThemeColor);
  // 底色只在真彩/256 档画得出来；ansi 与透明档给的是默认底（和画布底同序列）→ 当作没有。
  const usable = band !== '' && band !== theme.bgSeq('bg');
  return {
    band: usable ? band : '',
    number: kind === 'ctx' ? 'muted' : accent,
    // 有底色时内容退回正文色（一块绿底 + 白字比绿底 + 绿字好读）；没有底色就整行走增删色。
    content: usable ? 'text' : kind === 'ctx' ? 'toolOutput' : accent,
  };
}

/**
 * write 写整份内容：新行号 1..N（旧列留空）。edit 是片段对比：从命中行起算，旧/新各走各的。
 * 没有起点（replace_all、或工具没报命中行）就返回空表——不画行号。
 */
function changeLineNumbers(change: FileChange): { old?: number; new?: number }[] {
  const base = change.lineBase;
  if (base === undefined) return [];
  let oldLine = base;
  let newLine = base;
  return change.lines.map((line) => {
    if (line.kind === 'add') return { new: newLine++ };
    if (line.kind === 'del') return { old: oldLine++ };
    return { old: oldLine++, new: newLine++ };
  });
}


export interface ToolResultInput {
  content: string;
  isError: boolean;
}

/**
 * 工具 ID → 界面显示名。
 *
 * 工具 ID 是给模型看的（read / edit），界面上要的是人一眼能读的短名，
 * 单个工具行与 subagent 活动行用的就是这一列。未登记的工具回落成 ID 本身。
 */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  grep: 'Grep',
  glob: 'Glob',
  ls: 'List',
  bash: 'Bash',
  pwsh: 'Pwsh',
  web_search: 'Search',
  web_fetch: 'Fetch',
  task: 'Task',
  todo: 'Todo',
  skill: 'Skill',
  mcp: 'MCP',
  ask_user: 'Ask',
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
    case 'bash':
    case 'pwsh':
      return oneLine(pick('command', 'cmd'));
    case 'read':
    case 'write':
    case 'ls':
      return oneLine(pick('path', 'file_path', 'filePath'));
    case 'grep':
    case 'glob':
      return oneLine(pick('pattern', 'query'));
    case 'edit':
      return oneLine(pick('path', 'file_path'));
    case 'web_fetch':
      return oneLine(pick('url'));
    case 'web_search': {
      const queries = args.queries;
      if (Array.isArray(queries)) {
        return oneLine(queries.filter((item) => typeof item === 'string').join(', '));
      }
      return oneLine(pick('query', 'url'));
    }
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
  readonly [SELECTABLE_ROW] = true as const;
  /** 详情上的双击是收起，不参与选词；拖选复制仍走字符粒度。 */
  readonly [SUPPRESS_MULTI_CLICK_SELECTION] = true as const;
  private readonly toolName: string;
  private readonly toolCallId: string;
  private args: Record<string, unknown>;
  private result: ToolResultInput | undefined;
  private isPartial = true;
  private started = false;
  /** 成员详情：组展开时仍为 false。edit / write 的短 diff 不依赖它。 */
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
  /** 同一份参数的对比结果。成功之后每帧重画标题时不再重跑对齐。 */
  private changeCache: { args: Record<string, unknown>; change: FileChange | undefined } | undefined;

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
      // 悬停只铺标题行。移出的清除由 TUI.onMouseMotion 先行（先清后亮）。
      // 详情行不铺：那一块是拖选复制的，整行亮底会盖住输出。
      if (event.type === 'move') {
        if (event.y === 0 && this.setHovered(true)) {
          armHoverHighlight(() => this.setHovered(false));
          this.ui.invalidateContent();
        }
        return undefined;
      }
      if (event.button !== 'left') return undefined;
      // 分行路由（y 为组件内行号，0 = 标题行）：
      // - 标题行按压：接管，供合成 click——双击展开的触发面。单击留下选中底。
      // - 正文行按压：放行给拖选——工具输出仍可划选后右键复制。
      //   双击不选词：这一下是收起（或再展开一级），和选词抢同一次点击。
      //   组件带 SUPPRESS_MULTI_CLICK_SELECTION，选择层不会把这次按压升级成词/行选区。
      //   原位松开仍会合成 click，双击详情照常开合。
      if (event.type === 'press') {
        if (event.y !== 0) return undefined;
        const press = handleSelectablePress(this, event);
        if (press) return press;
      }
      if (event.type !== 'click') return undefined;
      this.selectRow();
      if (this.doubleClick.accept(event.x, event.y)) this.toggleDetail();
      return { handled: true };
    });
    this.addChild(this.region);
    this.updateDisplay();
  }

  private hovered = false;
  private selected = false;
  private readonly releaseSelection = (): boolean => this.setSelected(false);

  /** 单击标题或详情都算选中这一行；底只画在标题上。 */
  private selectRow(): void {
    selectTranscriptRow(this.releaseSelection);
    if (this.setSelected(true)) this.ui.invalidateContent();
  }

  /** 标题行整行铺底：悬停一档，选中更亮一档。 */
  private paintTitleChrome(): void {
    this.titleText.setCustomBgFn(rowChromeBg(this.selected, this.hovered));
    this.titleDirty = true;
  }

  private setHovered(on: boolean): boolean {
    if (this.hovered === on) return false;
    this.hovered = on;
    this.paintTitleChrome();
    return true;
  }

  private setSelected(on: boolean): boolean {
    if (this.selected === on) return false;
    this.selected = on;
    this.paintTitleChrome();
    return true;
  }

  get id(): string {
    return this.toolCallId;
  }

  /** 汇总行与标题行共用的短名。 */
  displayName(): string {
    return toolDisplayName(this.toolName);
  }

  /** 状态行在这条还在执行时显示的文案。子代理不叫 Task，避免和普通工具抢同一句。 */
  runningLabel(): string {
    if (this.subagentMeta) {
      return WorkingLabel.running('Subagent', `${this.subagentMeta.index} ${this.subagentMeta.description}`);
    }
    if (this.toolName === 'task' || this.toolName === 'subagent') {
      return WorkingLabel.running('Subagent', summarizeArgs(this.toolName, this.args));
    }
    return WorkingLabel.running(this.displayName(), summarizeArgs(this.toolName, this.args));
  }

  /** 原始工具 ID（read_file / grep…）：汇总行按它归动词，显示名（Read / Grep）会丢信息。 */
  rawName(): string {
    return this.toolName;
  }

  updateArgs(args: Record<string, unknown>): void {
    this.args = args;
    this.changeCache = undefined;
    this.updateDisplay();
    this.onStateChange?.();
  }

  markExecutionStarted(): void {
    this.started = true;
    this.updateDisplay();
    this.onStateChange?.();
    this.ui.invalidateContent();
  }

  setArgsComplete(): void {
    this.updateDisplay();
    this.ui.invalidateContent();
  }

  updateResult(result: ToolResultInput, isPartial = false): void {
    this.result = result;
    this.isPartial = isPartial;
    this.updateDisplay();
    this.onStateChange?.();
    this.ui.invalidateContent();
  }

  /** 分组折叠成员详情时收回预览；不要用它来打开全文。 */
  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    if (!expanded) this.fullDetail = false;
    this.updateDisplay();
    this.ui.invalidateContent();
  }

  /**
   * 双击循环：收起 → 预览 →（bash / subagent）全文 → 收起。
   * Read / List / Grep 停在预览，不把整文件/整份清单打进转录。
   * edit / write：组内收起只留标题，展开画 diff（上限 80 行）；独立调用常驻预览。
   */
  toggleDetail(): void {
    if (!this.expanded) {
      this.expanded = true;
      this.fullDetail = false;
    } else if ((this.toolName === 'bash' || this.toolName === 'pwsh' || this.subagentMeta !== undefined) && !this.fullDetail) {
      this.fullDetail = true;
    } else {
      this.expanded = false;
      this.fullDetail = false;
    }
    this.updateDisplay();
    this.ui.invalidateContent();
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
    this.ui.invalidateContent();
  }

  /**
   * 更新子代理实时活动后缀：运行中是当前动作（`Running Grep…`），收尾时是 token 与耗时
   * （`45.2K · 2m13s`）。空文本清除后缀；error 时后缀用错误色——与块状态色无关，
   * 活动失败不代表调用失败。
   */
  setActivity(text: string, error = false): void {
    this.activity = text === '' ? undefined : { text, error };
    this.updateDisplay();
    this.ui.invalidateContent();
  }

  /**
   * 子代理的工具调用计数（`List ×16, Read ×4`），排在活动段之前。
   * 它是最先被宽度挤掉的一段——计数在展开后的成员行里还能看到，token 与耗时看不到。
   */
  setCounts(text: string): void {
    this.counts = text === '' ? undefined : { text };
    this.updateDisplay();
    this.ui.invalidateContent();
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

  /**
   * 前缀颜色跟随行文：非失败行都是 muted，与标题文字同色。
   *
   * 进行与完成同字形同色（`›`），靠标题 shimmer 停下来——
   * 一轮收尾只该静下来，不该整行换色。展开后才换成 `✦`。
   */
  /** List 折叠行带 `(N entries)`，一行里能看出有多少项。 */
  private listEntrySuffix(): string {
    if (this.toolName !== 'ls' || !this.result || this.result.isError) return '';
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
    const name = this.subagentMeta ? `Subagent ${this.subagentMeta.index}` : this.displayName();
    const rest = this.subagentMeta
      ? ` ${this.subagentMeta.description}`
      : `${summary ? ` ${summary}` : ''}${this.listEntrySuffix()}`;
    // 失败时第一眼是人话。原文留在展开后的详情里，不铺在标题上。
    const failure = status === 'error' && this.result ? ` · ${failureHeadline(this.result.content)}` : '';
    const change = this.fileChange();
    const activitySuffix = this.activity
      ? this.activity.error
        ? theme.fg('error', ` · ${this.activity.text}`)
        : theme.fg('muted', ` · ${this.activity.text}`)
      : '';
    const opened = this.expanded || this.fullDetail;
    const mark = toolMark(status, opened);
    const live = status === 'pending' || status === 'running';
    // 展开后只把工具名（Read / Glob）提成正文色 #c6c6c6。后面的路径、模式仍是 muted。
    const painted = status === 'error'
      ? theme.fg('error', `${name}${rest}${failure}`)
      : live
        ? theme.shimmer(`${name}${rest}`, Date.now())
        : opened
          ? `${theme.fg('text', name)}${rest ? theme.fg('muted', rest) : ''}`
          : theme.fg('muted', `${name}${rest}`);
    const markColor: ThemeColor = status === 'error' ? 'error' : 'muted';
    this.titleLine = `${theme.fg(markColor, mark)} ${painted}`;
    this.countsLine = this.counts ? theme.fg('muted', ` · ${this.counts.text}`) : '';
    this.activityLine = activitySuffix;
    this.hintLine = change ? this.changeStat(change) : '';
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
   * 组内默认不渲染工具原文；双击后给头尾预览，Shell 再双击一次给全文。
   * edit / write 成功时改画 diff，组展开就能看到，不必再点一次。
   */
  /** 成功之后才对比。失败仍走原来的错误正文，避免把没落地的修改画成已改。 */
  private fileChange(): FileChange | undefined {
    if (this.status() !== 'success') return undefined;
    if (this.toolName !== 'edit' && this.toolName !== 'write') return undefined;
    if (this.changeCache?.args === this.args) return this.changeCache.change;
    // edit 的片段 diff 要真行号：命中行从工具结果里取（格式见 search-replace 的返回）。
    const matchLine = matchLineFromResult(this.result?.content ?? '');
    const change = fileChangeFromArgs(this.toolName, this.args, matchLine);
    this.changeCache = { args: this.args, change };
    return change;
  }

  private changeStat(change: FileChange): string {
    const all = change.replaceAll ? theme.fg('muted', ' · all') : '';
    return `${theme.fg('muted', ' · ')}${theme.fg('success', `+${change.added}`)} ${theme.fg('error', `-${change.removed}`)}${all}`;
  }

  private updateBody(width: number): void {
    const change = this.fileChange();
    if (change) {
      // 组内未展开的成员只留标题行——`›` = 收起 = 没有详情，与其它工具同一道闸。
      // write/edit 的 diff 之前不走这道闸，收起后 diff 还整块挂在标题下面。
      if (this.compact && !this.expanded) {
        this.bodyText.setText('');
        return;
      }
      this.bodyText.setText(this.paintChange(change, width));
      return;
    }
    const output = this.result?.content?.trim() ?? '';
    if (!output || (this.compact && !this.expanded)) {
      this.bodyText.setText('');
      return;
    }

    // 输出本身就是统一 diff（`git diff` / `git show` 这类）：文件头/hunk 头/增删/上下文各归各的
    // 取色，增删行带底色。判定见 looksLikeUnifiedDiff——只认结构标记，不猜内容。
    const diffBody = this.result?.isError !== true && looksLikeUnifiedDiff(output);
    const kindOf = (source: string): UnifiedDiffLineKind => (diffBody ? unifiedDiffLineKind(source) : 'meta');
    const sources = output.split(/\r\n|\r|\n/);
    // 语言从 diff 头（`+++ b/路径`）里取：原样输出的是已改文件的新代码。
    const lang = diffBody ? languageForDiffHeader(sources) : undefined;
    const gutter = lineNumberGutter(diffBody ? diffLineNumbers(sources) : []);
    const inner = Math.max(1, width - TOOL_DETAIL_INDENT - gutter.width);
    const pad = detailRailPad();
    const assemble = ({ text, paint, lead, prePainted }: DiffBodyRow): string =>
      `${pad}${lead}${paintedBody(text, paint, inner, prePainted)}`;
    if (this.fullDetail || this.result?.isError) {
      const rows: DiffBodyRow[] = [];
      sources.forEach((source, index) => rows.push(...diffBodyRows(source, kindOf(source), index, gutter, inner, lang)));
      // diff 与上下内容都隔一行（非 diff 的普通输出不加）；空行带竖轨（pad），轨才不断。
      this.bodyText.setText(
        [diffBody ? pad : undefined, ...rows.map(assemble), diffBody ? pad : undefined]
          .filter((row) => row !== undefined)
          .join('\n'),
      );
      return;
    }

    const { first, last } = previewWindow(this.toolName);
    const content = previewContentLines(this.toolName, output);
    const visual: DiffBodyRow[] = [];
    content.forEach((source, index) => visual.push(...diffBodyRows(source, kindOf(source), index, gutter, inner, lang)));
    const cap = first + last;
    if (visual.length <= cap) {
      this.bodyText.setText(
        [diffBody ? pad : undefined, ...visual.map(assemble), diffBody ? pad : undefined]
          .filter((row) => row !== undefined)
          .join('\n'),
      );
      return;
    }
    // 省略行数按内容行算，与窗口同一把尺子：用户看到 `… (174 more)` 就知道后文还有多少行正文，
    // 而不是只有裸的 `…` 让人以为折叠点后面没什么东西了。
    const skipped = visual.length - cap;
    const head = visual.slice(0, first).map(assemble);
    const tail = visual.slice(-last).map(assemble);
    // 省略符与折行续行同一缩进：它标的是「正文被折掉的一截」，跟着正文走，不自成一行。
    const markerIndent = hangingIndent(content[0] ?? '');
    const ellipsis = `${pad}${' '.repeat(gutter.width + markerIndent)}${theme.fg('muted', `… (${skipped} more)`)}`;
    this.bodyText.setText(
      [diffBody ? pad : undefined, ...head, ellipsis, ...tail, diffBody ? pad : undefined]
        .filter((row) => row !== undefined)
        .join('\n'),
    );
  }

  /**
   * 画 write/edit 的文件差异。调用方已保证该画：独立调用（非组内）常驻预览长度，
   * 组内成员只在双击展开后进来，放到更长的上限。
   */
  private paintChange(change: FileChange, width: number): string {
    const pad = detailRailPad();
    const gutter = lineNumberGutter(changeLineNumbers(change));
    const inner = Math.max(1, width - TOOL_DETAIL_INDENT - gutter.width);
    const limit = this.expanded || this.fullDetail ? DIFF_EXPANDED_LINES : DIFF_PREVIEW_LINES;
    const lang = languageForPath(change.path ?? '');
    const rows: DiffBodyRow[] = [];
    const shown = change.lines.slice(0, limit);
    shown.forEach((line, index) => rows.push(...diffBodyRows(line.text, line.kind, index, gutter, inner, lang)));
    // `… N more` 是块尾说明行：不带号（index = -1），也不带底色。
    const rest = change.lines.length - shown.length;
    if (rest > 0) rows.push(...diffBodyRows(`… ${rest} more`, 'meta', -1, gutter, inner));
    // 块首块尾各留一个空行：diff 与上方标题、下方内容都隔开。空行带竖轨（pad），轨才不断。
    return [
      pad,
      ...rows.map(({ text, paint, lead, prePainted }) => `${pad}${lead}${paintedBody(text, paint, inner, prePainted)}`),
      pad,
    ].join('\n');
  }

  override render(width: number): string[] {
    const live = this.status() === 'pending' || this.status() === 'running';
    if (live || this.titleDirty || this.titleWidth !== width) {
      if (!live) this.titleDirty = false;
      this.titleWidth = width;
      if (live) this.updateDisplay();
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
