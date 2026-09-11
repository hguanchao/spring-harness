/**
 * TUI 主循环：键盘路由 + agent 轮次调度 + 命令面板。
 *
 * 关键结构是「单一按键消费者」：runTurn 与本地的审批/提问浮层都要等用户输入，但它们
 * 不能各自去读 stdin。所有按键统一进 dispatch()，由它按当前 phase 路由到浮层或输入行，
 * 浮层用 Promise 把结果回给等待中的 agent 调用，从而不会出现两处抢 stdin 的情况。
 *
 * 界面是**全屏**的（终端替代屏幕缓冲区）：对话历史存在 body[] 里，每帧由 render() 组合成
 * 「历史视口 + 底部活动区」一整屏交给 Terminal.paint 覆盖式绘制。所以不再有「滚动区写一次
 * 就不变、活动区跟着重绘」的分工，也没有「先清活动区再写滚动区」的先后要求——任何输入都
 * 只是改状态、然后重绘一帧。代价是放弃终端原生滚动历史，回看改由 PgUp/PgDn 驱动 state.scroll。
 *
 * body[] 存的是**可重排的块**而不是折好行的字符串：宽度变化时块会按新宽度重新折行
 * （见 bodyLines），因此拖动窗口之后历史不会留着旧宽度的硬折痕。
 */

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentListener } from '../agent/events.js';
import { runTurn } from '../agent/loop.js';
import { createLlmClassifier } from '../approval/auto.js';
import { APPROVAL_MODES, type ApprovalMode, type ApprovalRequest } from '../approval/policy.js';
import { updateConfigFile } from '../config/save.js';
import type { ApiProtocol } from '../config/load.js';
import { REASONING_EFFORTS, type LlmClient, type ReasoningEffort, type TokenUsage } from '../llm/openai.js';
import { MODEL_CACHE_TTL_MS, readModelCache, readModelMeta, writeModelCache, writeModelMeta } from '../llm/model-cache.js';
import type { McpHub } from '../mcp/hub.js';
import type { JobBoard } from '../runtime/jobs.js';
import type { PersistentShell } from '../runtime/persistent-shell.js';
import { SpillStore } from '../runtime/spill.js';
import type { TodoList } from '../runtime/todos.js';
import type { SandboxHandle } from '../sandbox/open.js';
import { exportJson, exportMarkdown } from '../session/export.js';
import { foldSessionState, sessionEventData, type FoldedSessionState, type SessionFailure } from '../session/fold.js';
import { createSession, JsonlSession, listSessions, setCurrentSession, type SessionInfo } from '../session/store.js';
import { colorDepth, colorEnabled, createStyler, truncate, type Styler } from './ansi.js';
import { InteractiveApprover } from './approver.js';
import {
  backspace, deleteForward, emptyEditor, insertText, killToEnd, killToStart, killWordBefore,
  moveDown, moveEnd, moveHome, moveLeft, moveRight, moveUp, newline, setText, type EditorState,
} from './editor.js';
import { KeyParser, type Key } from './keys.js';
import { readGitBranch } from './git.js';
import { applyAgentEvent, createState, todoSummary, transcriptFromMessages, type FormPrompt, type MenuItem, type NoticeLevel, type TranscriptEntry, type TuiState } from './state.js';
import { InputQueue, Terminal } from './terminal.js';
import {
  anchorScroll, composeFrame, maxScroll, renderEntry, renderHeader, renderLive, renderStepBlock,
  selectionText, toolCallOf, type BodyRegion, type StepBlockRows, type StepThinkingView,
  type ToolBlockRegion, type UserPromptRegion, type ViewOptions,
} from './view.js';
import { writeClipboard } from './clipboard.js';
import type { Cell, Selection } from './state.js';
import type { ToolCallView } from './tool-view.js';

export interface TuiDeps {
  workspaceRoot: string;
  sessionDir: string;
  /** config.toml 路径：/model、/effort、/approval 的选择写回这里，下次启动仍生效。 */
  configPath: string;
  baseUrl: string;
  contextWindow: number;
  maxTokens?: number;
  sandbox: SandboxHandle;
  session: JsonlSession;
  mcp: McpHub;
  mcpServerCount: number;
  todos: TodoList;
  jobs: JobBoard;
  persistent: PersistentShell;
  approvalMode: ApprovalMode;
  model: string;
  api: ApiProtocol;
  effort?: ReasoningEffort;
  /** /model 与 /effort 改动后按新参数重建 client。 */
  makeClient(options: { model: string; api: ApiProtocol; effort?: ReasoningEffort; maxTokens?: number }): LlmClient;
  fetchModels(): Promise<readonly string[]>;
  /** 上游模型目录的磁盘缓存路径；省略用 ~/.sph/models.json（测试可注入临时路径避免污染主目录）。 */
  modelCachePath?: string;
  /** CLI 显式给了 --model：启动时不被会话里记录的模型覆盖（切换会话仍然尊重会话记录）。 */
  modelPinned?: boolean;
  /** 压缩摘要 / auto 审批审查器专用模型（来自配置）；省略都回退主模型。 */
  compactModel?: string;
  reviewModel?: string;
  /** spill 落盘根目录；省略则不做超长结果落盘（测试默认）。 */
  spillRoot?: string;
  /** spill 阈值（字符），0 关闭。 */
  spillThreshold?: number;
}

const COMMAND_ITEMS: readonly MenuItem[] = [
  { id: 'help', label: '/help', hint: 'List all commands and key bindings' },
  { id: 'new', label: '/new', hint: 'Start a new session' },
  { id: 'sessions', label: '/sessions', hint: 'Browse and switch sessions' },
  { id: 'status', label: '/status', hint: 'Show the full status panel' },
  { id: 'plan', label: '/plan', hint: 'Enter or leave plan mode (read-only research, then plan review)' },
  { id: 'goal', label: '/goal', hint: 'Set, view, or clear the goal for a long-running task' },
  { id: 'model', label: '/model', hint: 'Fetch models from the upstream and write the choice to config.toml' },
  { id: 'effort', label: '/effort', hint: 'View or set reasoning effort (written back to config.toml)' },
  { id: 'approval', label: '/approval', hint: 'View or set the approval mode: ask | auto | yolo (written back to config.toml)' },
  { id: 'todo', label: '/todo', hint: 'Show the to-do list' },
  { id: 'jobs', label: '/jobs', hint: 'Show background jobs' },
  { id: 'export', label: '/export', hint: 'Export this session (md | json)' },
  { id: 'clear', label: '/clear', hint: 'Clear the conversation view' },
  { id: 'quit', label: '/quit', hint: 'Quit' },
];

/** 命令名集合：由菜单项派生，避免菜单与解析表漂移。 */
const COMMAND_NAMES = new Set<string>([...COMMAND_ITEMS.map((item) => item.id), 'exit', 'switch']);

interface OptionEntry {
  /** 传给命令的值。 */
  value: string;
  /** 一句话说明，显示在选项右侧。 */
  hint: string;
}

/**
 * 带二级选项的斜杠命令。
 *
 * 菜单里对这类命令按 Enter 不是「执行」而是「下钻」：列出候选值让你上下选，避免
 * 还得记参数怎么写。没有列在这里的命令要么是零参动作（/help、/clear…），要么开的是
 * 动态列表（/sessions、/switch 从会话目录读）或多步向导（/model）。
 */
interface ModelWizardDraft {
  /** select = 选模型；context = 表单里填上下文窗口与输出上限；confirm = 等用户敲 y 写盘。 */
  stage: 'select' | 'context' | 'confirm';
  models: readonly string[];
  model?: string;
  contextWindow?: number;
  maxTokens?: number;
}

const DEFAULT_CONTEXT_WINDOW = 256_000;
// 与配置示例及协议默认约定保持一致；用户仍可在第二步的表单里覆盖它。
const DEFAULT_MAX_TOKENS = 8_192;

const OPTION_TABLE: Readonly<Record<string, readonly OptionEntry[]>> = {
  approval: [
    { value: 'ask', hint: 'Ask you for every reviewed tool' },
    { value: 'auto', hint: 'LLM reviewer first; escalates to you when it denies' },
    { value: 'yolo', hint: 'Allow everything without asking (dangerous)' },
  ],
  effort: REASONING_EFFORTS.map((level) => ({
    value: level,
    hint: level === 'off' ? 'Do not send an effort level' : `${level} reasoning effort`,
  })),
  export: [
    { value: 'md', hint: 'Export as Markdown' },
    { value: 'json', hint: 'Export as raw JSON' },
  ],
};

const HELP_LINES = [
  'Commands',
  ...COMMAND_ITEMS.map((item) => `  ${item.label.padEnd(16)}${item.hint}`),
  '  /switch <id>    Switch to a session (an id prefix works)',
  '',
  'Keys: Enter send | / command menu | Ctrl+K all actions | Up/Down history | Ctrl+L clear view',
  '      Wheel / PgUp / PgDn scroll back (Esc returns to the latest) | Esc abort turn / close overlay',
  '      Ctrl+C abort turn (clears the input when idle), press twice to quit | Ctrl+D quit',
  '',
  'The full-screen UI has no terminal scrollbar; scroll back with the wheel or PgUp/PgDn.',
  // 拖选由程序自己实现，手势刻意对齐终端原生：左键拖动选择（松手后高亮仍在），右键复制。
  // 之所以不在松手时复制：那样一段半成品会瞬间覆盖剪贴板，用户既没机会反悔也不知道覆盖了什么。
  'Selecting is implemented in the app: drag with the left button, release and the highlight stays,',
  'then right-click to copy (OSC 52 first, platform command as fallback).',
  'Click empty space or press any key to clear the selection.',
  'Double-click a tool block to list its calls, then a single call to show its output.',
  "Set SPH_MOUSE=0 to get the terminal's own drag-selection back (the wheel stops working).",
  '',
  'Lines are measured with CJK-aware width. Table borders use box-drawing characters by default;',
  'set SPH_TABLE_BORDER=ascii if your terminal renders them double-width and the frame drifts.',
];

/** /sessions 回放与首屏最多写多少条，避免一次刷屏几十屏。 */
const REPLAY_LIMIT = 40;
const HISTORY_LIMIT = 200;
/** info/success 级提示的存活时间；warn/error 留到用户下一次操作。 */
const NOTICE_TTL_MS = 4000;
/** git 分支的重新读取间隔：状态行高频重绘，不能每帧读盘。 */
const BRANCH_TTL_MS = 2000;
/**
 * 拖动窗口时相邻两次整帧重绘的最小间隔（前缘节流）。
 *
 * 整帧重绘本身对 resize 是天然正确的——每次覆盖一整屏，重排留下的旧像素会被整个抹掉，
 * 不可能像之前的相对光标实现那样叠加残影。这里限流只是为了不被「每拖一步抛一次」的
 * 事件风暴拖垮：立即响应一次，其后最多 20 帧/秒。
 */
const RESIZE_MIN_INTERVAL_MS = 50;
/** 回看翻页时保留的重叠行数：刚好切在两行中间时还能看清上下文。 */
const PAGE_OVERLAP = 1;
/** 滚轮一格的滚动行数。多数终端一格 = 3 行，跟随这个惯例手感最自然。 */
const WHEEL_STEP = 3;
/** 工具块双击展开/收起的时间窗口；与终端常见双击节奏一致。 */
const DOUBLE_CLICK_MS = 500;
/** SGR 鼠标的按键码：0 左、1 中、2 右。与 keys.ts 里剥掉修饰位后的 code 对齐。 */
const RIGHT_BUTTON = 2;
/**
 * 「连按两次 Ctrl+C 退出」的判定窗口。
 *
 * 单击 Ctrl+C 是**中断**，不是退出——这是终端几十年的惯例，一键退出会让「只想停掉
 * 这一步」的人误伤整个会话。所以要退出必须连按两次，且两次间隔要短到明显是「同一个
 * 意图」。1 秒足够：手快的人连按远小于 1 秒，而「中断完想了想再退出」通常不止 1 秒。
 */
const DOUBLE_CTRL_C_MS = 1000;

/**
 * 可用列数 = 终端上报列数 - 1。
 *
 * 留一列安全带：老 conhost（cmd.exe）上报的 columns 可能比实际可写区宽 1 列，写到那一列
 * 会提前换行。整帧绘制里一行折成两行，会让整屏内容整体上移一行再被底部截掉一行。宁可少用一列。
 */
function liveWidth(columns: number): number {
  return Math.max(20, columns - 1);
}

/**
 * 鼠标滚轮是否启用；`SPH_MOUSE=0|false|off|no` 关闭。
 *
 * 默认开。界面跑在替代屏幕（alt screen）里，**终端自身的滚动能力在这里是失效的**：
 * 没有 scrollback 可滚、滚动条拖不动、滚轮也不会被转发给我们。所以不接滚轮，用户
 * 会认为「窗口根本滚不动」。代价是终端不再自己处理鼠标拖选——Windows Terminal 下要
 * 按住 Shift 才是原生选择——因此留这个开关作为退路。
 */
export function mouseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.SPH_MOUSE ?? '').trim().toLowerCase();
  return value !== '0' && value !== 'false' && value !== 'off' && value !== 'no';
}

/**
 * 对话历史里的一块。
 *
 * 存的是「怎么渲染」而不是「渲染成什么」：`render(width)` 在宽度变化时重新生成 lines，
 * 所以 resize 之后历史会按新宽度重新折行，而不是留着旧宽度的硬折痕。
 * `live` 的块每帧都重排（流式正文的内容一直在变），其余块只在宽度变化时重排一次。
 */
interface BodyBlock {
  lines: readonly string[];
  /** lines 是按哪个宽度渲染的；决定是否需要重排。 */
  width: number;
  render?: (width: number) => readonly string[];
  live?: boolean;
  /** 块前插入一个空行（呼吸空间）；前一行已经是空行时不会再插。 */
  blank?: boolean;
  /** 流式块归属的条目：用来判断流是不是已经翻到新的一条了。 */
  entry?: TranscriptEntry;
  /** 工具块的可变展开状态；保留模型后双击才能重新排版历史。 */
  toolBlock?: ToolBlockState;
}

interface ToolBlockState {
  id: string;
  items: ToolCallView[];
  /** 这一步的思考链（推理模型/扩展思考才有）。 */
  thinking?: StepThinkingView;
  /** 一级展开：是否显示思考行与各调用行。 */
  expanded: boolean;
  /** 上一次渲染时每行占的行区间（相对块首行），双击时用它判命中。 */
  itemRows?: StepBlockRows;
}

interface ToolBlockHit extends ToolBlockRegion {
  block: BodyBlock;
}

interface BodySnapshot {
  lines: string[];
  userPrompts: UserPromptRegion[];
  toolBlocks: ToolBlockHit[];
}

export async function runTui(deps: TuiDeps): Promise<void> {
  await new TuiApp(deps).run();
}

class TuiApp {
  private readonly state: TuiState;
  private readonly terminal: Terminal;
  private readonly input = new InputQueue();
  private readonly parser = new KeyParser();
  private readonly styler: Styler;
  private readonly approver: InteractiveApprover;

  private session: JsonlSession;
  private client: LlmClient;
  private model: string;
  private contextWindow: number;
  private maxTokens?: number;
  private api: ApiProtocol;
  private effort?: ReasoningEffort;
  private readonly compactClient?: LlmClient;
  private readonly reviewClient?: LlmClient;
  private approvalModeValue: ApprovalMode;
  private planMode = false;
  /** 跨轮次任务目标（/goal 设置），落盘为 goal 事件。 */
  private goal?: string;
  /** 最近一次工具失败（渲染层从 tool_end 事件同步），随下一轮注入提示词。 */
  private lastFailure?: SessionFailure;
  private running = false;
  private abort?: AbortController;
  /** 本轮发送的用户消息是否仍作为对话流顶部锚点；用户主动翻页后解除。 */
  private pinUserPrompt = false;
  /** 吸顶锚点的尾部预留空间；手动回看时保留，避免短回复把滚动位置夹回底部。 */
  private reserveUserPrompt = false;

  /** 对话历史：可重排的块列表（正文、工具块、横幅、命令反馈都按块存）。 */
  private readonly body: BodyBlock[] = [];
  /** 正在流式增长的块；它每帧重排，其余块只在宽度变化时重排。 */
  private streamBlock?: BodyBlock;
  /** 合并同一时刻内的多次重绘请求（流式正文可能在一个事件循环里来好几段）。 */
  private renderQueued = false;
  /** 上一帧历史视口的高度，PgUp/PgDn 按它翻页。 */
  private lastBodyRows = 10;
  /** 上一帧对话流在屏幕上的真实行区间，用于判断滚轮是否落在对话流内。 */
  private lastBodyRegion: BodyRegion = { top: 0, rows: 0, contentTop: 0, contentIndex: 0, contentRows: 0 };
  /** 上一帧画出的行。选区取文本要用——选区存的是屏幕坐标，只能对着最终帧取。 */
  /**
   * 上一帧的正文行。选区存的是**内容坐标**（正文行下标），复制时直接按它取文本，
   * 不去反查屏幕——这样内容滚出视口也照样能复制到。
   */
  private lastBody: readonly string[] = [];
  /** 工具块双击判定只记录屏幕行，同一行短时间再次按下才切换折叠状态。 */
  private lastClick?: { row: number; at: number; id: string };
  /** 上一帧历史的总行数，用于滚动锚定（视口上方内容长高时同步推偏移）。 */
  private lastBodyLength = 0;
  /** 本步攒下的工具调用，等这一步结束一次性渲染成块。 */
  private pendingTools: ToolCallView[] = [];
  /** 工具块 id 只用于屏幕命中映射，不写入会话，避免与工具调用 id 混淆。 */
  private nextToolBlockId = 0;
  private lastToolBlocks: readonly ToolBlockHit[] = [];
  private lastFrameToolBlocks: readonly { top: number; bottom: number; id: string }[] = [];
  private readonly toolStartedAt = new Map<string, number>();
  private stepToolCount = 0;
  private spinnerTimer?: NodeJS.Timeout;
  private noticeTimer?: NodeJS.Timeout;
  /** 上次读 git 分支的时间（2s 节流）。 */
  private lastBranchCheck = 0;
  /** resize 节流计时器。 */
  private resizeTimer?: NodeJS.Timeout;
  private lastResizePaint = 0;
  private escTimer?: NodeJS.Timeout;
  private menuOptions?: { parent: string; entries: readonly OptionEntry[] };
  private modelWizard?: ModelWizardDraft;
  /**
   * 上游模型目录（内存缓存）。启动时先用磁盘缓存填上、再后台刷新一次，因此 `/model` 通常
   * 不需要等网络；`fetchedAt` 用来判断这份列表是不是已经过期、要不要顺手再刷。
   */
  private modelCatalog?: { models: readonly string[]; fetchedAt: number };
  /** 进行中的拉取。并发调用（启动预热 + 用户立刻敲 /model）共用同一次请求。 */
  private catalogPending?: Promise<readonly string[]>;
  private sessions: SessionInfo[] = [];
  private lastSize = { width: 0, height: 0 };

  constructor(private readonly deps: TuiDeps) {
    this.session = deps.session;
    this.model = deps.model;
    this.contextWindow = deps.contextWindow;
    this.maxTokens = deps.maxTokens;
    this.api = deps.api;
    this.effort = deps.effort;
    this.approvalModeValue = deps.approvalMode;
    this.client = deps.makeClient({ model: deps.model, api: deps.api, effort: deps.effort, maxTokens: deps.maxTokens });
    // 辅助模型固定一次即可：它们只由配置决定，运行时的 /model 改的是主模型。
    this.compactClient = deps.compactModel === undefined
      ? undefined
      : deps.makeClient({ model: deps.compactModel, api: deps.api, effort: deps.effort, maxTokens: deps.maxTokens });
    this.reviewClient = deps.reviewModel === undefined
      ? undefined
      : deps.makeClient({ model: deps.reviewModel, api: deps.api, effort: deps.effort, maxTokens: deps.maxTokens });
    this.styler = createStyler(colorEnabled(), colorDepth());
    const mouse = mouseEnabled();
    this.terminal = new Terminal((text) => this.feed(text), mouse);
    // 分类器按需构造：/model 换模型后审查器要跟着用新 client，闭包不能固化旧实例。
    // 配置了 review_model 时审查器始终用它——这是「便宜模型跑杂活」最直接的落点。
    this.approver = new InteractiveApprover(this, (request) =>
      createLlmClassifier(this.reviewClient ?? this.client, {
        onUsage: (usage) => this.recordAuxUsage(usage, 'review'),
      })(request));
    this.state = createState({
      model: deps.model,
      api: deps.api,
      effort: deps.effort,
      approvalMode: deps.approvalMode,
      sandboxMode: deps.sandbox.status.mode,
      sandboxEnforcement: deps.sandbox.status.enforcement,
      sessionId: deps.session.id,
      workspaceRoot: deps.workspaceRoot,
      contextWindow: deps.contextWindow,
      mcpServers: deps.mcpServerCount,
      mcpTools: deps.mcp.listTools().length,
      mouse,
    });
    // 恢复上次会话留下的状态（todo / plan / 模型 / 目标）。用 events 折叠而不是另存状态文件：
    // 会话本来就是 append-only 日志，状态是它的投影，两边不会漂移。
    const restored = this.restoreSessionState({ overrideModel: deps.modelPinned !== true });
    if (restored.length > 0) this.notify(`Restored from the session: ${restored.join(', ')}`);
  }

  /**
   * 用会话事件折叠出的状态覆盖进程内状态，返回恢复了哪些东西（供提示）。
   *
   * plan 模式恢复后**必须可见**：它会削减可用工具，静默恢复等于让用户以为工具“坏了”。
   * 折叠失败只当没有状态——恢复是增益，不该成为启动的前置条件。
   */
  private restoreSessionState(options: { overrideModel: boolean }): string[] {
    let folded: FoldedSessionState;
    try {
      folded = foldSessionState(this.session.readAll());
    } catch {
      return [];
    }
    // 先清空再按事件重建：切到一个没有 todo 事件的会话时，上一段的清单不该留着。
    this.clearSessionState();
    const notes: string[] = [];
    if (folded.todos.length > 0) {
      this.deps.todos.replace(folded.todos);
      notes.push(`${folded.todos.length} to-dos`);
    }
    if (folded.planMode) {
      this.setPlan(true, false);
      notes.push('plan mode (/plan to leave)');
    }
    if (folded.goal) {
      this.goal = folded.goal;
      notes.push('goal');
    }
    this.lastFailure = folded.failures.at(-1);
    if (options.overrideModel && folded.model && folded.model !== this.model) {
      this.model = folded.model;
      this.contextWindow = folded.contextWindow ?? this.contextWindow;
      this.maxTokens = folded.maxTokens ?? this.maxTokens;
      this.client = this.deps.makeClient({
        model: this.model,
        api: this.api,
        effort: this.effort,
        maxTokens: this.maxTokens,
      });
      this.state.model = this.model;
      this.state.contextWindow = this.contextWindow;
      notes.push(`model ${this.model}`);
    }
    return notes;
  }

  /** 清空全部会话级状态（新会话、切换会话、折叠前都要走这里）。 */
  private clearSessionState(): void {
    this.deps.todos.replace([]);
    this.goal = undefined;
    this.lastFailure = undefined;
    this.setPlan(false, false);
  }

  /** 事件落盘；失败只影响「下次能不能恢复」，不打断当前交互。 */
  private appendEvent(kind: string, data: Record<string, unknown>): boolean {
    try {
      this.session.append({ type: 'event', ts: new Date().toISOString(), kind, data });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 辅助调用（压缩摘要 / 审批审查）的用量落盘。
   * 刻意不发给渲染层：状态行的上下文占用必须只反映主请求，否则审查器会把水位推高。
   */
  private recordAuxUsage(usage: TokenUsage, purpose: string): void {
    this.appendEvent('usage', { ...usage, purpose });
  }

  // ---------------------------------------------------------------- 生命周期

  async run(): Promise<void> {
    this.terminal.enter(() => this.handleResize());
    const restoreOnExit = (): void => this.terminal.restore();
    process.on('exit', restoreOnExit);
    try {
      // 首屏不再往对话流里塞横幅：本次会话的参数（模型/协议/审批/沙箱）与键位提示
      // 都已在标题栏与状态栏里，横幅只会白占几行、还得多按几次 PgUp 才能翻过去。
      this.warmModelCatalog();
      this.render();
      for (;;) {
        const key = await this.input.next();
        if (!key) break;
        this.dispatch(key);
      }
    } finally {
      process.off('exit', restoreOnExit);
      this.stopSpinner();
      if (this.escTimer) clearTimeout(this.escTimer);
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.terminal.restore();
    }
  }

  /**
   * Ctrl+C：单击中断，连按两次退出。
   *
   * 运行中单击 = 中断本轮；空闲时没有可中断的任务，退化成终端惯例的「清空输入行」。
   * 两种情况下第一次按都只给提示、不退出，第二次（窗口内）才真的退出。
   */
  private handleCtrlC(): void {
    const now = Date.now();
    const again = now - this.lastCtrlCAt <= DOUBLE_CTRL_C_MS;
    this.lastCtrlCAt = now;
    if (again) {
      this.quit();
      return;
    }
    if (this.state.phase === 'running') {
      this.abortTurn();
      this.notify('Turn aborted · press Ctrl+C again to quit');
      this.render();
      return;
    }
    // 空闲：按终端惯例清掉输入行；本来就是空的就只给提示。
    const hadText = this.state.editor.text !== '';
    if (hadText) this.state.editor = emptyEditor();
    this.notify(hadText ? 'Input cleared · press Ctrl+C again to quit' : 'Press Ctrl+C again to quit');
    this.render();
  }

  /** 上一次按下 Ctrl+C 的时刻，用于「连按两次退出」的判定。 */
  private lastCtrlCAt = 0;

  private quit(): void {
    this.abortTurn();
    this.input.close();
  }

  // ---------------------------------------------------------------- 输入

  /** raw stdin 文本 → 按键 → 队列。半截序列留待下次；单独的 Esc 延时兜底。 */
  private feed(text: string): void {
    this.pushKeys(this.parser.push(text));
    if (this.escTimer) clearTimeout(this.escTimer);
    if (this.parser.pending) {
      this.escTimer = setTimeout(() => {
        this.escTimer = undefined;
        this.pushKeys(this.parser.flushPending());
      }, 40);
    }
  }

  private pushKeys(keys: readonly Key[]): void {
    if (keys.length > 0) this.input.push(keys);
  }

  private dispatch(key: Key): void {
    // 终端协议事件（水平滚轮）显式丢弃，不进入任何交互路径。
    if (key.kind === 'ignore') return;
    // 鼠标按键：交给应用内选区，绝不能落进文本输入（那会把协议字节写进输入行）。
    if (key.kind === 'mouse') return this.handleMouseKey(key);
    this.lastClick = undefined;
    // 滚动不清选区：选区存的是内容坐标，视口移动不会让它错位（原生终端也保留）。
    const scrolling = key.kind === 'pageup' || key.kind === 'pagedown' || key.kind === 'wheel';
    if (!scrolling) this.clearSelection();
    if (this.state.prompt) return this.handlePromptKey(key);
    if (this.state.phase === 'menu') return this.handleMenuKey(key);
    if (this.state.phase === 'status') {
      this.state.phase = 'idle';
      this.render();
      return;
    }
    if (this.handleScrollKey(key)) return;
    if (this.state.phase === 'running') {
      if (key.kind === 'escape') this.abortTurn();
      // Ctrl+C 走「单击中断、双击退出」；Esc 仍是单击即中断（没有退出语义，不需要防误触）。
      if (key.kind === 'ctrl' && key.key === 'c') this.handleCtrlC();
      return;
    }
    return this.handleIdleKey(key);
  }

  /**
   * 回看历史。放在 phase 路由之前，所以运行中也能往上翻。
   *
   * 返回 true 表示这个按键已经被滚动消费掉了。
   */
  private handleScrollKey(key: Key): boolean {
    if (key.kind === 'pageup' || (key.kind === 'wheel' && key.direction === 'up')) {
      this.pinUserPrompt = false;
    }
    if (key.kind === 'pagedown' || (key.kind === 'wheel' && key.direction === 'down') || key.kind === 'escape') {
      this.pinUserPrompt = false;
      this.reserveUserPrompt = false;
    }
    if (key.kind === 'pageup') {
      this.scrollTo(this.state.scroll + this.pageSize());
      return true;
    }
    if (key.kind === 'pagedown') {
      this.scrollTo(this.state.scroll - this.pageSize());
      return true;
    }
    if (key.kind === 'wheel') {
      // 滚轮只在对话流区域内生效：标题栏、输入区、状态栏上的滚轮一律不响应。
      // 这些区域本来就没有可滚内容，让它们吞掉滚轮只会让人以为「滚到别处去了」。
      // 坐标是 1 基的，先转成 0 基行号再比区间。
      const row = key.row - 1;
      const { top, rows } = this.lastBodyRegion;
      if (row < top || row >= top + rows) return true; // 消费掉，但不滚动
      // 滚轮一次一格手感太肉，按行给一个固定步长。
      this.scrollTo(this.state.scroll + (key.direction === 'up' ? WHEEL_STEP : -WHEEL_STEP));
      return true;
    }
    // Esc 分两级：回看中先回到底部，再按一次才轮到「中断本轮」。避免翻历史时误中断。
    if (key.kind === 'escape' && this.state.scroll > 0) {
      this.scrollTo(0);
      return true;
    }
    return false;
  }

  /**
   * 鼠标按键：左键拖动选择，**右键才复制**（模拟终端原生的拖选手势）。
   *
   * 与旧实现的唯一区别是「什么时候复制」：以前是 copy-on-select（松手即入剪贴板），现在松手
   * 只结束选择、高亮留在屏幕上，右键才是那个明确的「就它了」。好处是选多了还能接着调——
   * 松手瞬间就把一段半成品塞进剪贴板，用户既没机会反悔也不知道自己覆盖了什么。
   *
   * 中键在多数终端是粘贴、右键各家语义不一；这里只把右键定义成复制，中键不参与。
   * 选中期间不做任何别的事：不滚屏、不改输入行、不切 phase。
   */
  private handleMouseKey(key: Extract<Key, { kind: 'mouse' }>): void {
    // 右键 = 复制。只在按下沿处理一次（终端还会补一个释放报文，那一个不用管）。
    if (key.button === RIGHT_BUTTON) {
      if (key.release || !this.state.selection) return;
      void this.copySelection(this.state.selection);
      return;
    }
    if (key.button !== 0) return; // 其余按键（中键等）不参与选区

    const row = Math.max(0, key.row - 1);
    const col = Math.max(0, key.col - 1);

    if (!key.release && !key.motion) {
      const now = Date.now();
      const previous = this.lastClick;
      if (
        previous !== undefined
        && now - previous.at <= DOUBLE_CLICK_MS
        && previous.row === row
        && previous.id === this.toolBlockAtScreenRow(row)
        && this.toggleToolBlockAt(row)
      ) {
        this.lastClick = undefined;
        return;
      }
      const toolBlockId = this.toolBlockAtScreenRow(row);
      this.lastClick = toolBlockId === undefined ? undefined : { row, at: now, id: toolBlockId };
    }

    if (key.release) {
      const current = this.state.selection;
      if (!current) return;
      const cell = this.cellAt(row, col);
      // 单击（按下与松开落在同一格）按终端惯例取消选择；拖动之后松手则**保留高亮**等右键。
      // 松手落在正文区外（拖出去了）不算单击——那明显是一次拖动。
      const empty = cell !== undefined
        && current.anchor.row === cell.row
        && current.anchor.col === cell.col;
      if (empty) {
        this.state.selection = undefined;
        this.render();
      }
      return;
    }

    const cell = this.cellAt(row, col);
    if (cell === undefined) {
      // 正文之外（标题栏 / 输入区 / 状态栏 / 补白）：不在这里起选区。
      // 落在这儿的单击顺手取消旧选区，等同终端里「点空白处取消选择」。
      if (!key.motion) this.clearSelection();
      return;
    }
    if (key.motion && !this.state.selection) return; // 起点在正文外的拖动不做选择
    this.state.selection = key.motion
      ? { ...this.state.selection!, head: cell }
      : { anchor: cell, head: cell };
    this.render();
  }

  /**
   * 屏幕坐标 → 正文内容坐标。落在正文内容之外返回 undefined。
   *
   * 拖到边缘之外时返回 undefined，调用方因此不会更新 head —— 效果就是「停在最后一行/列」，
   * 和终端里把鼠标拖出窗口一样。
   */
  private cellAt(row: number, col: number): Cell | undefined {
    const { contentTop, contentIndex, contentRows } = this.lastBodyRegion;
    const index = contentIndex + (row - contentTop);
    if (row < contentTop || row >= contentTop + contentRows) return undefined;
    if (index < 0 || index >= this.lastBody.length) return undefined;
    return { row: index, col };
  }

  /** 查找鼠标所在的工具块；工具块命中区只来自上一帧，和选区一样不跨帧猜测。 */
  private toolBlockAtScreenRow(row: number): string | undefined {
    return this.lastFrameToolBlocks.find((region) => row >= region.top && row < region.bottom)?.id;
  }

  /** 双击：块头切换一级展开，落在某条调用行上则切换那一条的详情。 */
  private toggleToolBlockAt(row: number): boolean {
    const id = this.toolBlockAtScreenRow(row);
    if (id === undefined) return false;
    const hit = this.lastToolBlocks.find((region) => region.id === id);
    if (!hit) return false;
    if (hit.block.toolBlock) {
      const state = hit.block.toolBlock;
      // itemRows 是**内容坐标**（见 bodyLines），屏幕行必须先换算回内容行——
      // 否则回看一段历史之后，双击会打中错误的那一条。
      const body = this.lastBodyRegion;
      const offset = body.contentIndex + (row - body.contentTop) - hit.start;
      const rows = state.itemRows;
      const thinkingRow = rows?.thinking;
      if (state.thinking && thinkingRow && offset >= thinkingRow.start && offset < thinkingRow.end) {
        state.thinking.expanded = state.thinking.expanded !== true;
      } else {
        const index = (rows?.items ?? []).findIndex(
          (span) => span !== undefined && offset >= span.start && offset < span.end,
        );
        const item = index >= 0 ? state.items[index] : undefined;
        if (item) item.expanded = item.expanded !== true;
        // 落在块头（或已折叠的块里任意一行）上：切换整块的一级展开。
        else state.expanded = !state.expanded;
      }
    } else if (hit.block.entry?.kind === 'tool') {
      hit.block.entry.collapsed = hit.block.entry.collapsed === false;
    } else {
      return false;
    }
    const width = this.viewOptions().width;
    if (hit.block.render) {
      hit.block.lines = hit.block.render(width);
      hit.block.width = width;
    }
    this.state.selection = undefined;
    this.render();
    return true;
  }

  /**
   * 清掉选区。**滚动不调用它**：选区存的是内容坐标，视口上下移动不会让它错位
   * （原生终端的行为也是「滚了选中的还是那段字」）。敲键时清，是因为敲键通常意味着
   * 「选完了/改主意了」，而且像 Ctrl+L、提交新消息这类操作会大改正文，留着反而是隐患。
   */
  private clearSelection(): void {
    if (!this.state.selection) return;
    this.state.selection = undefined;
    this.render();
  }

  /**
   * 复制选区。文本直接取自**正文行**，不再从上一帧的屏幕上反查——选区本来就是内容坐标，
   * 这样复制到的内容与视口位置无关（哪怕这段文字已经滚出屏幕）。
   */
  private async copySelection(selection: Selection): Promise<void> {
    const text = selectionText(this.lastBody, selection);
    // 先撤高亮再写剪贴板：写可能要走原生命令（几十毫秒），高亮留着会让人以为还能再复制一次。
    this.state.selection = undefined;
    this.render();
    if (text === '') return;
    const result = await writeClipboard(text);
    // 提示要诚实：只有原生命令退出码 0 才算「确定写进去了」；OSC 52 是只写通道，
    // 终端支不支持我们收不到反馈，所以只能报「已发送」而不是「已复制」。
    if (result === 'native') this.notify('Copied to clipboard');
    else if (result === 'osc52') this.notify('Copy request sent (OSC 52)', 'warn');
    else this.notify('Copy failed: neither the system clipboard nor OSC 52 is available', 'error');
    this.render();
  }

  /**
   * 一屏可翻的行数，去掉与上一屏的重叠部分。
   *
   * 刻意**不用上一帧的活动区行数**：活动区固定在底部，按稳定的对话流高度计算，
   * 这样 PgUp 与紧随的 PgDn 使用同一页大小，按一下上一页、按一下下一页可以回到原位。
   */
  private pageSize(): number {
    const height = this.terminal.size().height;
    const settled = renderLive(this.state, this.viewOptions()).lines.length;
    return Math.max(1, height - Math.max(settled, this.lastBodyRows) - PAGE_OVERLAP);
  }

  private scrollTo(offset: number): void {
    // 上限由 render() 按历史长度夹住。
    this.state.scroll = Math.max(0, offset);
    this.render();
  }

  private handleIdleKey(key: Key): void {
    // 任何输入都表示「回到最新」：正在打字却还盯着历史会很别扭。
    this.pinUserPrompt = false;
    this.reserveUserPrompt = false;
    if (this.state.scroll > 0) {
      this.state.scroll = 0;
      this.render();
    }
    if (key.kind === 'enter') {
      const text = this.state.editor.text.trim();
      if (text === '') return;
      if (text.startsWith('/')) this.submitSlash(text);
      else this.startTurn(text);
      return;
    }
    if (key.kind === 'up' && this.state.editor.text === '') return this.historyPrev();
    if (key.kind === 'down') return this.historyNext();
    if (key.kind === 'escape') {
      this.state.editor = emptyEditor();
      this.render();
      return;
    }
    if (key.kind === 'ctrl') {
      if (key.key === 'c') return this.handleCtrlC();
      // Ctrl+D 保留为「一键退出」：连按两次 Ctrl+C 之外总得留一条不打断任务的退路。
      if (key.key === 'd' && this.state.editor.text === '') return this.quit();
      if (key.key === 'k') return this.openCommandMenu('');
      if (key.key === 'l') {
        this.clearBody();
        return;
      }
    }
    const next = applyEditorKey(this.state.editor, key, this.composerTextWidth());
    if (!next) return;
    this.state.editor = next;
    this.syncCommandMenu();
    this.render();
  }

  /**
   * 输入形如 `/xxx`（尚未敲空格）时自动展开命令菜单，并把已敲的名字当作过滤词；
   * 一旦出现空格说明用户在写参数（`/approval yolo`），菜单收起、Enter 直接执行。
   */
  private syncCommandMenu(): void {
    const text = this.state.editor.text;
    if (/^\/\S*$/.test(text)) {
      if (!this.state.menu) this.openCommandMenu(text);
      else this.syncMenuFilter();
      return;
    }
    if (this.state.menu && !this.menuOptions) {
      // 只收起菜单、不清空输入行：此刻输入行里是用户正在写的参数。
      this.state.menu = undefined;
      this.state.phase = this.running ? 'running' : 'idle';
    }
  }

  // ---------------------------------------------------------------- 浮层按键

  private handlePromptKey(key: Key): void {
    const prompt = this.state.prompt;
    if (!prompt) return;
    const cancel = key.kind === 'escape' || (key.kind === 'ctrl' && key.key === 'c');

    if (prompt.kind === 'approval') {
      if (key.kind === 'up' || key.kind === 'down') {
        const choices = ['allow', 'allow-session', 'deny'] as const;
        const current = choices.indexOf(prompt.choice);
        const delta = key.kind === 'up' ? -1 : 1;
        prompt.choice = choices[(current + delta + choices.length) % choices.length];
        return this.render();
      }
      if (key.kind === 'enter') {
        if (prompt.choice === 'allow-session') this.approver.allowForSession(prompt.request.tool);
        return this.settlePrompt(() => prompt.resolve(prompt.choice !== 'deny'));
      }
      const char = key.kind === 'text' ? key.text.toLowerCase() : '';
      if (char === '1') return this.settlePrompt(() => prompt.resolve(true));
      if (char === '2') {
        this.approver.allowForSession(prompt.request.tool);
        return this.settlePrompt(() => prompt.resolve(true));
      }
      if (char === '3') return this.settlePrompt(() => prompt.resolve(false));
      if (char === 'y') return this.settlePrompt(() => prompt.resolve(true));
      if (char === 'n') return this.settlePrompt(() => prompt.resolve(false));
      if (char === 'a') {
        this.approver.allowForSession(prompt.request.tool);
        return this.settlePrompt(() => prompt.resolve(true));
      }
      if (cancel) return this.settlePrompt(() => prompt.resolve(false));
      return;
    }

    if (prompt.kind === 'ask') {
      if (key.kind === 'enter') {
        const answer = prompt.editor.text.trim();
        return this.settlePrompt(() => prompt.resolve(answer));
      }
      if (cancel) return this.settlePrompt(() => prompt.resolve(''));
      const next = applyEditorKey(prompt.editor, key, this.composerTextWidth());
      if (!next) return;
      prompt.editor = next;
      return this.render();
    }

    if (prompt.kind === 'form') return this.handleFormKey(key, prompt);

    // plan：空输入时按 y 批准；有输入时 Enter 作为驳回意见。
    if (key.kind === 'text' && key.text.toLowerCase() === 'y' && prompt.editor.text === '') {
      return this.settlePrompt(() => prompt.resolve({ approved: true }));
    }
    if (key.kind === 'enter') {
      const feedback = prompt.editor.text.trim();
      return this.settlePrompt(() => prompt.resolve(feedback === '' ? { approved: false } : { approved: false, feedback }));
    }
    if (cancel) return this.settlePrompt(() => prompt.resolve({ approved: false }));
    const next = applyEditorKey(prompt.editor, key, this.composerTextWidth());
    if (!next) return;
    prompt.editor = next;
    this.render();
  }

  /**
   * 表单浮层按键。
   *
   * 没有按钮行：Enter 提交、Esc 取消，Tab / 上下键在字段之间循环，左右键始终是移动文本光标
   * （输入框的直觉）。纯确认框（无字段）只剩 Enter / Esc 两个动作。
   */
  private handleFormKey(key: Key, prompt: FormPrompt): void {
    const fieldCount = prompt.fields.length;

    if (key.kind === 'escape' || (key.kind === 'ctrl' && key.key === 'c')) {
      return this.settlePrompt(() => prompt.resolve(undefined));
    }
    if (fieldCount === 0) {
      if (key.kind === 'enter') return this.submitForm(prompt);
      return;
    }
    const slots = fieldCount;
    const moveFocus = (delta: number): void => {
      prompt.focus = (prompt.focus + delta + slots) % slots;
      // 焦点一动就清掉旧报错：用户已经在改了，挂着上一条提示只会误导。
      prompt.error = undefined;
      this.render();
    };
    if (key.kind === 'tab' || key.kind === 'down') return moveFocus(1);
    if (key.kind === 'up') return moveFocus(-1);
    if (key.kind === 'enter') return this.submitForm(prompt);

    const field = prompt.fields[Math.min(Math.max(0, prompt.focus), fieldCount - 1)];
    const next = applyFieldKey(field.editor, key, this.composerTextWidth());
    if (!next) return;
    field.editor = next;
    prompt.error = undefined;
    this.render();
  }

  /**
   * 提交表单：先收集各字段文本（已 trim）交给 validates 钩子，不通过就只记下错误、保持弹窗
   * 打开，已填内容一个不丢；通过才 resolve 并关闭。
   */
  private submitForm(prompt: FormPrompt): void {
    const values: Record<string, string> = {};
    for (const field of prompt.fields) values[field.key] = field.editor.text.trim();
    const error = prompt.validate?.(values);
    if (error !== undefined) {
      prompt.error = error;
      return this.render();
    }
    this.settlePrompt(() => prompt.resolve(values));
  }

  /** 浮层收尾：先清掉引用再 resolve，避免回调里再触发一次按键路由。 */
  private settlePrompt(resolve: () => void): void {
    this.state.prompt = undefined;
    this.state.phase = this.running ? 'running' : 'idle';
    resolve();
    this.render();
  }

  // ---------------------------------------------------------------- 菜单

  private handleMenuKey(key: Key): void {
    const menu = this.state.menu;
    if (!menu) {
      this.closeMenu();
      return;
    }
    if (key.kind === 'escape' || (key.kind === 'ctrl' && key.key === 'c')) {
      if (this.modelWizard?.stage === 'select') return this.cancelModelWizard();
      // 二级菜单里 Esc 是「返回上一级」，再按一次才关菜单——和文件管理器的直觉一致。
      if (this.menuOptions) return this.backToCommands();
      return this.closeMenu();
    }
    if (key.kind === 'up' || key.kind === 'down') {
      if (menu.items.length === 0) return;
      const delta = key.kind === 'up' ? -1 : 1;
      menu.index = (menu.index + delta + menu.items.length) % menu.items.length;
      return this.render();
    }
    if (key.kind === 'enter') return this.runMenuSelection();
    // 二级菜单里、过滤串已空时再按退格：等同于返回上一级。
    if (key.kind === 'backspace' && this.menuOptions && this.state.editor.text === '') {
      return this.backToCommands();
    }
    const next = applyEditorKey(this.state.editor, key, this.composerTextWidth());
    if (!next) return;
    this.state.editor = next;
    this.syncMenuFilter();
    this.render();
  }

  /** 输入行同时是菜单的过滤框；过滤后把高亮夹回有效范围。 */
  private syncMenuFilter(): void {
    const menu = this.state.menu;
    if (!menu) return;
    const raw = this.state.editor.text.trim();
    // 一级菜单的输入行带着 `/` 前缀，二级菜单的输入行就是纯粹的过滤词。
    menu.filter = this.menuOptions ? raw : raw.startsWith('/') ? raw.slice(1) : raw;
    const query = menu.filter.toLowerCase();
    menu.items = this.menuItems().filter(
      (item) =>
        query === '' ||
        item.id.toLowerCase().startsWith(query) ||
        item.label.toLowerCase().includes(query) ||
        item.hint.toLowerCase().includes(query),
    );
    menu.index = Math.min(menu.index, Math.max(0, menu.items.length - 1));
  }

  /** 一级：命令列表；二级：当前命令的候选值。 */
  private menuItems(): MenuItem[] {
    if (this.modelWizard?.stage === 'select') {
      // 标题已经写明「选择上游模型」，每行再挂一遍同样的说明只是噪声；
      // 只标出当前生效的模型，其余行留空，列表才能一眼扫完。
      return this.modelWizard.models.map((model) => ({
        id: model,
        label: model,
        hint: model === this.model ? 'current' : '',
      }));
    }
    if (!this.menuOptions) return [...COMMAND_ITEMS];
    const current = this.currentOptionValue(this.menuOptions.parent);
    return this.menuOptions.entries.map((entry) => ({
      id: entry.value,
      label: entry.value,
      hint: entry.value === current ? `${entry.hint} (current)` : entry.hint,
    }));
  }

  /** 一级菜单：`/` 或 Ctrl+K 打开。initial 是输入行已有内容（`/xxx`）。 */
  private openCommandMenu(initial: string): void {
    this.menuOptions = undefined;
    this.state.editor = initial === '' ? emptyEditor() : setText(initial);
    this.state.menu = { title: 'Commands', items: [], index: 0, filter: '' };
    this.state.phase = 'menu';
    this.syncMenuFilter();
    this.render();
  }

  /**
   * 二级菜单：列出某个命令的候选值，并把高亮预置到当前值上。
   * 输入行留空：它就是过滤框，面板标题里已经写明了父命令。
   */
  private openOptionsMenu(parent: string, entries: readonly OptionEntry[], current?: string): void {
    this.menuOptions = { parent, entries };
    this.state.editor = emptyEditor();
    this.state.menu = { title: `Commands | /${parent}`, items: [], index: 0, filter: '', nested: true };
    this.state.phase = 'menu';
    this.syncMenuFilter();
    const at = current === undefined ? -1 : entries.findIndex((entry) => entry.value === current);
    if (at >= 0 && this.state.menu) this.state.menu.index = at;
    this.render();
  }

  /** 从二级菜单回到一级（保留在菜单里，不回到输入状态）。 */
  private backToCommands(): void {
    this.openCommandMenu('');
  }

  /** 当前生效的值，用于在二级菜单里标注「（当前）」并预置高亮。 */
  private currentOptionValue(parent: string): string | undefined {
    if (parent === 'approval') return this.approvalModeValue;
    if (parent === 'effort') return this.effort ?? 'off';
    return undefined;
  }

  private closeMenu(): void {
    this.state.menu = undefined;
    this.menuOptions = undefined;
    this.state.editor = emptyEditor();
    this.state.phase = this.running ? 'running' : 'idle';
    this.render();
  }

  private runMenuSelection(): void {
    const menu = this.state.menu;
    if (!menu) return;
    const item = menu.items.length > 0 ? menu.items[Math.min(menu.index, menu.items.length - 1)] : undefined;

    if (this.modelWizard?.stage === 'select') {
      if (!item) {
        this.notify('Select a model from the upstream list', 'warn');
        this.render();
        return;
      }
      this.selectModelWizardModel(item.id);
      return;
    }

    // 二级菜单：选中即应用，然后关掉整个菜单。
    if (this.menuOptions && item) {
      const parent = this.menuOptions.parent;
      this.closeMenu();
      this.applyOption(parent, item.id);
      return;
    }

    const typed = this.state.editor.text.trim();
    const parsed = parseSlashInput(typed);
    // 手打了参数（`/approval yolo`）或过滤后没有候选：按输入执行。
    if ((parsed && parsed.args !== '') || !item) {
      if (parsed && COMMAND_NAMES.has(parsed.name)) {
        this.closeMenu();
        this.executeCommand(parsed.name, parsed.args, true);
        return;
      }
      this.notify(typed === '' ? 'No command to run' : `Unknown command: ${typed}`, 'warn');
      this.render();
      return;
    }

    // 一级菜单：有候选值的命令下钻，其余直接执行。
    const options = OPTION_TABLE[item.id];
    if (options) {
      this.openOptionsMenu(item.id, options, this.currentOptionValue(item.id));
      return;
    }
    this.closeMenu();
    this.executeCommand(item.id, '', true);
  }

  /** 二级菜单选中后的落点：值交给对应命令，复用同一条执行路径。 */
  private applyOption(parent: string, value: string): void {
    this.clearNotice();
    if (parent === 'approval') this.setApprovalMode(value);
    else if (parent === 'effort') this.setEffort(value);
    else if (parent === 'export') this.exportSession(value);
    else if (parent === 'sessions') this.switchSession(value);
    else this.executeCommand(parent, value, true);
    this.render();
  }

  // ---------------------------------------------------------------- 命令

  private submitSlash(text: string): void {
    const parsed = parseSlashInput(text);
    if (!parsed || !COMMAND_NAMES.has(parsed.name)) {
      this.notify(`Unknown command: ${text} (type / to see all commands)`, 'warn');
      this.render();
      return;
    }
    this.rememberHistory(text);
    this.executeCommand(parsed.name, parsed.args, true);
  }

  /**
   * 一次性提示：按级别着色，info/success 到时自动消失，warn/error 留到用户下一次操作。
   * 超时只在「没被后续提示覆盖」时生效，避免把新提示提前清掉。
   */
  private notify(text: string, level: NoticeLevel = 'info'): void {
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = undefined;
    }
    this.state.notice = { text, level };
    if (level === 'info' || level === 'success') {
      this.noticeTimer = setTimeout(() => {
        this.noticeTimer = undefined;
        this.state.notice = undefined;
        this.render();
      }, NOTICE_TTL_MS);
    }
  }

  private clearNotice(): void {
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = undefined;
    }
    this.state.notice = undefined;
  }

  private executeCommand(name: string, args: string, clearInput: boolean): void {
    if (clearInput) this.state.editor = emptyEditor();
    this.clearNotice();
    switch (name) {
      case 'help':
        this.commit((width) => HELP_LINES.map((line) => truncate(line, width, '')));
        break;
      case 'new':
        this.session = createSession(this.deps.sessionDir, this.deps.workspaceRoot);
        this.state.sessionId = this.session.id;
        this.clearSessionState();
        this.commit((width) => [truncate(`== New session ${this.session.id} ==`, width, '')]);
        break;
      case 'sessions':
        void this.openSessionsMenu();
        return;
      case 'switch':
        if (args.trim() === '') {
          void this.openSessionsMenu();
          return;
        }
        void this.switchTo(args.trim());
        return;
      case 'status':
        this.state.phase = 'status';
        break;
      case 'plan':
        this.setPlan(!this.planMode);
        this.notify(`Plan mode ${this.planMode ? 'on (read-only tools; the plan runs only after you approve it)' : 'off'} · saved to the session, restored on restart`);
        break;
      case 'goal':
        this.setGoal(args);
        break;
      case 'model':
        if (args.trim() !== '') {
          this.notify('/model does not take a model ID — run /model and pick from the upstream list', 'warn');
          break;
        }
        void this.openModelWizard();
        return;
      case 'effort':
        if (args.trim() === '') {
          this.openOptionsMenu('effort', OPTION_TABLE.effort, this.currentOptionValue('effort'));
          return;
        }
        this.setEffort(args.trim());
        break;
      case 'approval':
        if (args.trim() === '') {
          this.openOptionsMenu('approval', OPTION_TABLE.approval, this.approvalModeValue);
          return;
        }
        this.setApprovalMode(args.trim());
        break;
      case 'todo':
        this.commit((width) => this.todoLines().map((line) => truncate(line, width, '')));
        break;
      case 'jobs':
        this.commit((width) => this.jobLines().map((line) => truncate(line, width, '')));
        break;
      case 'export':
        if (args.trim() === '') {
          this.openOptionsMenu('export', OPTION_TABLE.export);
          return;
        }
        this.exportSession(args.trim());
        break;
      case 'clear':
        this.clearBody();
        break;
      case 'quit':
      case 'exit':
        this.quit();
        return;
      default:
        this.notify(`Unknown command: /${name}`, 'warn');
        break;
    }
    this.render();
  }

  private async openSessionsMenu(): Promise<void> {
    try {
      this.sessions = await listSessions(this.deps.sessionDir);
    } catch (error) {
      this.notify(`Could not read sessions: ${message(error)}`, 'error');
      this.render();
      return;
    }
    if (this.sessions.length === 0) {
      this.notify('No sessions yet in this workspace');
      this.render();
      return;
    }
    this.openOptionsMenu(
      'sessions',
      this.sessions.map((info) => ({
        value: info.id,
        hint: `${info.messages} messages | ${info.preview || '(empty session)'}`,
      })),
      this.state.sessionId,
    );
  }

  /** 菜单路径：会话列表已加载，直接按 id 激活。 */
  private switchSession(id: string): void {
    const file = join(this.deps.sessionDir, `${id}.jsonl`);
    if (!existsSync(file)) {
      this.notify(`Session file not found: ${id}`, 'error');
      this.render();
      return;
    }
    setCurrentSession(this.deps.sessionDir, id, this.deps.workspaceRoot);
    this.session = new JsonlSession(this.deps.sessionDir, id);
    this.state.sessionId = id;
    const restored = this.restoreSessionState({ overrideModel: true });
    const entries = transcriptFromMessages(this.session.readMessages());
    const shown = entries.slice(-REPLAY_LIMIT);
    const restoredNote = restored.length > 0 ? ` | restored: ${restored.join(', ')}` : '';
    const head = `== Switched to session ${id} | ${entries.length} entries${shown.length < entries.length ? `, showing the last ${shown.length}` : ''}${restoredNote} ==`;
    this.commit((width) => [truncate(head, width, '')]);
    for (let index = 0; index < shown.length; index++) {
      const entry = shown[index];
      if (entry.kind !== 'tool') {
        this.commit((width) => renderEntry(entry, this.optionsAt(width)), { entry });
        continue;
      }
      const items: ToolCallView[] = [];
      while (index < shown.length && shown[index].kind === 'tool') {
        items.push(toolCallOf(shown[index]));
        index++;
      }
      index--;
      this.commitToolBlock(items, true);
    }
    this.render();
  }

  /** `/switch <id 前缀>`：会话列表可能还没加载过，先按需取一次。 */
  private async switchTo(prefix: string): Promise<void> {
    if (prefix === '') {
      this.notify('Usage: /switch <session id prefix> (or pick from /sessions)');
      this.render();
      return;
    }
    if (this.sessions.length === 0) {
      try {
        this.sessions = await listSessions(this.deps.sessionDir);
      } catch (error) {
        this.notify(`Could not read sessions: ${message(error)}`, 'error');
        this.render();
        return;
      }
    }
    const hit = this.sessions.find((info) => info.id === prefix) ?? this.sessions.find((info) => info.id.startsWith(prefix));
    if (!hit) {
      this.notify(`No session matching: ${prefix} (try /sessions)`, 'warn');
      this.render();
      return;
    }
    this.switchSession(hit.id);
  }

  // ---------------------------------------------------------------- 上游模型目录

  /**
   * 启动时预热模型目录：先吃磁盘缓存，让 `/model` 秒开；再后台刷一次拿最新列表。
   *
   * 刻意**不 await**：上游慢或不通时绝不能把启动卡住。刷新失败也静默——用户没在等这个结果，
   * 真要看错误会去敲 `/model`，那里才给可见提示。
   */
  private warmModelCatalog(): void {
    const cached = readModelCache(this.deps.baseUrl, this.modelCachePath());
    if (cached) this.modelCatalog = { models: cached.models, fetchedAt: cached.fetchedAt };
    void this.refreshModels().catch(() => {});
  }

  private modelCachePath(): string | undefined {
    return this.deps.modelCachePath;
  }
  /** 磁盘缓存是否已过期（过期只是「该刷了」，不代表不能用）。 */
  private catalogStale(now = Date.now()): boolean {
    const catalog = this.modelCatalog;
    return catalog === undefined || now - catalog.fetchedAt > MODEL_CACHE_TTL_MS;
  }

  /**
   * 取模型目录：有缓存就直接给，没有才真去拉。
   *
   * 这是 `/model` 的快路径——用户第二次敲 `/model`、或本次启动命中磁盘缓存时，这里不发任何
   * 网络请求，弹窗立刻出现。
   */
  private loadModels(): Promise<readonly string[]> {
    const catalog = this.modelCatalog;
    return catalog ? Promise.resolve(catalog.models) : this.refreshModels();
  }

  /** 真去上游拉一次（进行中的请求会被复用），成功后写内存与磁盘。 */
  private refreshModels(): Promise<readonly string[]> {
    if (!this.catalogPending) this.catalogPending = this.fetchModelsOnce();
    return this.catalogPending;
  }

  private async fetchModelsOnce(): Promise<readonly string[]> {
    try {
      const models = await this.deps.fetchModels();
      if (models.length > 0) {
        this.modelCatalog = { models, fetchedAt: Date.now() };
        // 空列表不落盘（writeModelCache 里也再挡一道）：上游偶发返回空不该覆盖好缓存。
        writeModelCache(this.deps.baseUrl, models, this.modelCachePath());
      }
      return models;
    } finally {
      // 成功时 modelCatalog 已是快路径，清掉 pending 没有副作用；失败则允许下次重试。
      this.catalogPending = undefined;
    }
  }

  private async openModelWizard(): Promise<void> {
    if (this.running) {
      this.notify('A turn is still running — configure the model after it finishes', 'warn');
      this.render();
      return;
    }

    const warm = this.modelCatalog !== undefined;
    if (!warm) {
      // 只有「本次启动没命中缓存」才需要等；有缓存时连提示都不给，弹窗直接出来。
      this.notify('Fetching models from the configured base URL…', 'info');
      this.render();
    }
    let models: readonly string[];
    try {
      models = await this.loadModels();
    } catch (error) {
      this.notify(`Could not fetch upstream models: ${message(error)}`, 'error');
      this.render();
      return;
    }
    if (models.length === 0) {
      this.notify('The upstream returned no models', 'warn');
      this.render();
      return;
    }
    // 列表过期就顺手后台刷一次。刻意不 await、也不在菜单开着时去改 menu.items：
    // 选项列表在用户眼皮底下跳变（甚至换掉他正要按 Enter 的那一项）比列表旧一会儿糟糕得多。
    if (this.catalogStale()) void this.refreshModels().catch(() => {});

    this.modelWizard = { stage: 'select', models };
    this.menuOptions = undefined;
    this.state.editor = emptyEditor();
    this.state.menu = { title: 'Step 1/3 | Select a model', items: [], index: 0, filter: '', nested: true };
    this.state.phase = 'menu';
    this.syncMenuFilter();
    const current = models.indexOf(this.model);
    if (current >= 0 && this.state.menu) this.state.menu.index = current;
    this.render();
  }

  private selectModelWizardModel(model: string): void {
    const draft = this.modelWizard;
    if (!draft || draft.stage !== 'select') return;
    draft.model = model;
    draft.stage = 'context';
    this.state.menu = undefined;
    this.menuOptions = undefined;
    this.state.editor = emptyEditor();
    this.state.phase = 'idle';
    void this.continueModelWizard(draft);
  }

  private async continueModelWizard(draft: ModelWizardDraft): Promise<void> {
    const model = draft.model;
    if (!model) return this.cancelModelWizard();

    // 两个数值合成一次表单提交：它们本来就属于同一件事（这次请求能吃多少、能吐多少），
    // 分两步问会让用户在两个几乎一样的单行输入框之间来回走，还没法回头改上面那个。
    // 默认值优先取这个模型上次确认过的值——上游 /models 不返回窗口大小，只能靠本地沉淀。
    const known = readModelMeta(this.deps.baseUrl, model, this.modelCachePath());
    const values = await this.requestForm({
      title: 'Step 2/3 | Context window and max output',
      note: `Model: ${model}${known ? ' (pre-filled from the last time this model was configured)' : ''}\nIntegers only — no k/m suffix (write 256k as 256000). Enter confirms, Esc abandons this configuration`,
      fields: [
        {
          key: 'context_window',
          label: 'Context window',
          value: String(known?.contextWindow ?? DEFAULT_CONTEXT_WINDOW),
          placeholder: 'e.g. 256000',
        },
        {
          key: 'max_tokens',
          label: 'Max output tokens',
          value: String(known?.maxTokens ?? this.maxTokens ?? DEFAULT_MAX_TOKENS),
          placeholder: 'e.g. 8192',
        },
      ],
      validate: validateModelLimits,
    });
    // undefined = 用户取消：不写盘、不改内存里的模型配置，向导整体退出。
    if (values === undefined || this.modelWizard !== draft) return this.cancelModelWizard();

    // 能走到这里说明 validateModelLimits 已经放行，两个值必然能解析成整数。
    draft.contextWindow = parseTokenCount(values.context_window ?? '') ?? DEFAULT_CONTEXT_WINDOW;
    draft.maxTokens = parseTokenCount(values.max_tokens ?? '') ?? DEFAULT_MAX_TOKENS;
    draft.stage = 'confirm';

    // 第 3 步复用同一个表单浮层，只是不给它字段：回车即确认、Esc 即放弃。
    // 这样用户不必再记「要敲 y」这种一次性约定，整个向导只有一套确认手势。
    const confirmed = await this.requestForm({
      title: 'Step 3/3 | Write to config.toml',
      note: this.modelWizardSummary(draft),
      fields: [],
    });
    if (this.modelWizard !== draft) return;
    if (confirmed === undefined) return this.cancelModelWizard();
    this.applyModelWizard(draft);
  }

  /** 待写入的值。只列配置项本身，标题与「怎么确认」由浮层统一表达。 */
  private modelWizardSummary(draft: ModelWizardDraft): string {
    return [
      `base_url: ${displayBaseUrl(this.deps.baseUrl)}`,
      'api_key: configured (hidden)',
      `model: ${draft.model ?? ''}`,
      `context_window: ${draft.contextWindow ?? DEFAULT_CONTEXT_WINDOW}`,
      `max_tokens: ${draft.maxTokens ?? DEFAULT_MAX_TOKENS}`,
    ].join('\n');
  }

  private applyModelWizard(draft: ModelWizardDraft): void {
    const model = draft.model;
    const contextWindow = draft.contextWindow;
    const maxTokens = draft.maxTokens;
    if (!model || contextWindow === undefined || maxTokens === undefined) return this.cancelModelWizard();
    this.modelWizard = undefined;
    this.model = model;
    this.contextWindow = contextWindow;
    this.maxTokens = maxTokens;
    this.client = this.deps.makeClient({ model, api: this.api, effort: this.effort, maxTokens });
    this.state.model = model;
    this.state.contextWindow = contextWindow;
    // 记进会话：用同一个会话 resume 时应当回到当时用的模型，而不是当前配置里的模型。
    this.appendEvent('model_selection', sessionEventData.modelSelection({ model, contextWindow, maxTokens }));
    // 记进模型目录缓存：下次选中同一个模型（或在向导里 / --model 切回来）直接带出这两个值。
    writeModelMeta(this.deps.baseUrl, model, { contextWindow, maxTokens }, this.modelCachePath());
    const warning = this.persistConfig({ model, context_window: contextWindow, max_tokens: maxTokens });
    this.notify(`Model configured: ${model} | context ${contextWindow} | output ${maxTokens}${warning}`, warning === '' ? 'success' : 'warn');
    this.render();
  }

  private cancelModelWizard(): void {
    this.modelWizard = undefined;
    this.state.menu = undefined;
    this.menuOptions = undefined;
    this.state.editor = emptyEditor();
    this.state.phase = this.running ? 'running' : 'idle';
    this.notify('Model configuration cancelled');
    this.render();
  }

  private setEffort(level: string): void {
    if (level === '') {
      this.notify(`Reasoning effort: ${this.effort ?? 'off (unset)'} | available: ${REASONING_EFFORTS.join(' | ')}`);
      return;
    }
    if (!(REASONING_EFFORTS as readonly string[]).includes(level)) {
      this.notify(`Invalid effort: ${level} | available: ${REASONING_EFFORTS.join(' | ')}`, 'warn');
      return;
    }
    this.effort = level as ReasoningEffort;
    this.client = this.deps.makeClient({ model: this.model, api: this.api, effort: this.effort, maxTokens: this.maxTokens });
    this.state.effort = this.effort;
    const warning = this.persistConfig({ reasoning_effort: this.effort });
    this.notify(`Reasoning effort: ${this.effort}${warning}`, warning === '' ? 'success' : 'warn');
  }

  /**
   * 写回 config.toml。
   *
   * 失败只降级成提示、不抛：切换在本次进程内已经生效，不该因为磁盘只读/权限问题把已经
   * 生效的改动回滚掉。但也绝不静默——用户特意要的是「下次启动还在」。
   */
  private persistConfig(patch: Readonly<Record<string, string | number>>): string {
    try {
      updateConfigFile(this.deps.configPath, patch);
      return ` | written to ${this.deps.configPath}`;
    } catch (error) {
      return ` | could not write ${this.deps.configPath}: ${message(error)}`;
    }
  }

  private setApprovalMode(mode: string): void {
    if (mode === '') {
      this.notify(`Approval mode: ${this.approvalModeValue} | available: ${APPROVAL_MODES.join(' | ')}`);
      return;
    }
    if (!(APPROVAL_MODES as readonly string[]).includes(mode)) {
      this.notify(`Invalid approval mode: ${mode} | available: ${APPROVAL_MODES.join(' | ')}`, 'warn');
      return;
    }
    this.approvalModeValue = mode as ApprovalMode;
    this.state.approvalMode = mode;
    const warning = this.persistConfig({ approval: mode });
    this.notify(`Approval mode: ${mode}${warning}`, warning === '' ? 'success' : 'warn');
  }

  private setPlan(enabled: boolean, persist = true): void {
    this.planMode = enabled;
    this.state.planMode = enabled;
    if (persist) this.appendEvent('plan_mode', sessionEventData.planMode(enabled));
  }

  /** /goal：无参数查看、clear 清除、其余作为目标文本。 */
  private setGoal(args: string): void {
    const text = args.trim();
    if (text === '') {
      this.commit((width) => [
        truncate(this.goal ? `Goal: ${this.goal}` : 'No goal set (/goal <text> to set one, /goal clear to remove it)', width, ''),
      ]);
      return;
    }
    if (text === 'clear' || text === 'off' || text === 'none') {
      this.goal = undefined;
      const ok = this.appendEvent('goal', sessionEventData.goal(''));
      this.notify(`Goal cleared${ok ? '' : ' (the event could not be saved; this process only)'}`, ok ? 'success' : 'warn');
      return;
    }
    this.goal = text;
    const ok = this.appendEvent('goal', sessionEventData.goal(text));
    this.notify(`Goal set and injected into every request${ok ? '' : ' (the event could not be saved; it will not survive a restart)'}`, ok ? 'success' : 'warn');
  }

  private exportSession(format: string): void {
    const kind = format === 'json' ? 'json' : 'md';
    const file = join(this.deps.sessionDir, `${this.session.id}.${kind}`);
    try {
      writeFileSync(file, kind === 'json' ? exportJson(this.session) : exportMarkdown(this.session), 'utf8');
      this.notify(`Exported: ${file}`, 'success');
    } catch (error) {
      this.notify(`Export failed: ${message(error)}`, 'error');
    }
  }

  private todoLines(): string[] {
    const items = this.deps.todos.list();
    if (items.length === 0) return ['The to-do list is empty (the model has not called the todo tool yet)'];
    const mark = { pending: ' ', in_progress: '>', completed: 'x' } as const;
    return ['To-dos', ...items.map((item) => `  [${mark[item.status]}] ${item.id} ${item.content}`)];
  }

  private jobLines(): string[] {
    const jobs = this.deps.jobs.list();
    if (jobs.length === 0) return ['No background jobs'];
    return [
      'Background jobs',
      ...jobs.map((job) => `  ${job.id}  ${job.status}  ${job.kind}  ${job.command.slice(0, 60)}`),
    ];
  }

  // ---------------------------------------------------------------- agent 轮次

  private startTurn(prompt: string): void {
    if (this.running) return;
    this.rememberHistory(prompt);
    this.state.editor = emptyEditor();
    this.clearNotice();
    this.state.phase = 'running';
    const entry: TranscriptEntry = { kind: 'user', text: prompt };
    this.pinUserPrompt = true;
    this.reserveUserPrompt = true;
    this.commit((width) => renderEntry(entry, this.optionsAt(width)), { blank: true, entry });
    void this.executeTurn(prompt);
  }

  private rememberHistory(text: string): void {
    this.state.history.push(text);
    if (this.state.history.length > HISTORY_LIMIT) this.state.history.shift();
    this.state.historyIndex = -1;
  }

  private historyPrev(): void {
    const { history } = this.state;
    if (history.length === 0) return;
    const index = this.state.historyIndex < 0
      ? history.length - 1
      : Math.max(0, this.state.historyIndex - 1);
    this.state.historyIndex = index;
    this.state.editor = setText(history[index]);
    this.render();
  }

  private historyNext(): void {
    if (this.state.historyIndex < 0) return;
    const index = this.state.historyIndex + 1;
    if (index >= this.state.history.length) {
      this.state.historyIndex = -1;
      this.state.editor = emptyEditor();
    } else {
      this.state.historyIndex = index;
      this.state.editor = setText(this.state.history[index]);
    }
    this.render();
  }

  private async executeTurn(prompt: string): Promise<void> {
    const controller = new AbortController();
    this.abort = controller;
    this.running = true;
    this.startSpinner();
    const planState = {
      sessionMode: (this.planMode ? 'plan' : 'default') as 'default' | 'plan',
      exitPlan: (): void => this.setPlan(false),
    };
    try {
      await runTurn({
        prompt,
        workspaceRoot: this.deps.workspaceRoot,
        client: this.client,
        session: this.session,
        sandbox: this.deps.sandbox,
        approver: this.approver,
        contextWindow: this.contextWindow,
        listener: this.listener,
        signal: controller.signal,
        mcp: this.deps.mcp,
        todos: this.deps.todos,
        jobs: this.deps.jobs,
        persistent: this.deps.persistent,
        planState,
        goal: this.goal,
        lastFailure: this.lastFailure,
        compactClient: this.compactClient,
        onAuxUsage: (usage, purpose) => this.recordAuxUsage(usage, purpose),
        // spill 按会话分目录：切会话后旧结果仍留在各自目录里，不会互相覆盖。
        ...(this.deps.spillRoot === undefined
          ? {}
          : { spill: new SpillStore(join(this.deps.spillRoot, this.session.id), this.deps.spillThreshold) }),
      });
    } catch (error) {
      if (controller.signal.aborted) this.commit((width) => renderEntry({ kind: 'notice', text: 'Turn aborted', level: 'warn' }, this.optionsAt(width)), { blank: true });
      else this.commit((width) => renderEntry({ kind: 'error', text: message(error) }, this.optionsAt(width)), { blank: true });
    } finally {
      // 中断 / 报错时步骤块可能还开着，兜底定稿，否则这一步的记录会凭空消失。
      this.closeStepBlock();
      this.running = false;
      this.abort = undefined;
      this.state.activeTool = undefined;
      this.stopSpinner();
      // 轮次异常结束（中断/报错）时浮层可能还在等输入：兜底回绝，避免 agent 侧挂死。
      if (this.state.prompt) {
        const promptState = this.state.prompt;
        this.state.prompt = undefined;
        if (promptState.kind === 'approval') promptState.resolve(false);
        else if (promptState.kind === 'ask') promptState.resolve('');
        else if (promptState.kind === 'plan') promptState.resolve({ approved: false });
        // 表单按「取消」收场：既不写盘也不改内存里的配置，与用户按 Esc 完全同义。
        else promptState.resolve(undefined);
      }
      this.state.phase = 'idle';
      this.refreshCounters();
      this.render();
    }
  }

  /**
   * agent 事件 → 滚动区 / 活动区。
   *
   * 一次 LLM 调用的思考链与它发起的工具调用汇总在**同一个「步骤块」**里：块在 thinking_start
   * 打开，随思考增量、工具结果就地刷新，在下一步开始或轮次结束时定稿折回一行。这样既不会出现
   * thinking / tool / assistant 交替刷屏，历史里一行就能代表整步。
   */
  private readonly listener: AgentListener = (event) => {
    if (event.type === 'text') {
      applyAgentEvent(this.state, event);
      this.appendStream();
      return;
    }
    applyAgentEvent(this.state, event);
    const now = Date.now();

    switch (event.type) {
      case 'thinking_start':
        // 新的 LLM 调用 = 新的一步：上一步的块定稿，新的块开出来。
        this.closeStepBlock();
        this.stepToolCount = 0;
        this.thinkingStartedAt = now;
        this.openStepBlock();
        break;
      case 'thinking_delta': {
        const state = this.stepBlock?.toolBlock;
        if (state) {
          // 边想边显示：思考是推理模型最长的一段等待，憋到结束再吐出来等于没有反馈。
          state.thinking = { ...state.thinking, text: `${state.thinking?.text ?? ''}${event.text}` };
          this.scheduleRender();
        }
        break;
      }
      case 'thinking_end': {
        const state = this.stepBlock?.toolBlock;
        if (state) {
          // content 是权威全文：增量只用于过程中的展示，这里整体替换而不是拼接。
          const started = this.thinkingStartedAt;
          state.thinking = {
            text: event.content,
            done: true,
            ...(started === undefined ? {} : { ms: Math.max(0, now - started) }),
            ...(state.thinking?.expanded === true ? { expanded: true } : {}),
          };
          this.thinkingStartedAt = undefined;
          this.scheduleRender();
        }
        break;
      }
      case 'tool_start': {
        const state = this.stepBlock?.toolBlock ?? this.openStepBlock();
        const item: ToolCallView = { id: event.id, name: event.name, args: event.args, detail: '' };
        state.items.push(item);
        this.pendingTools.push(item);
        this.toolStartedAt.set(event.id, now);
        this.stepToolCount++;
        this.state.activeTool = {
          name: event.name,
          index: this.stepToolCount,
          total: this.stepToolCount,
          startedAt: now,
        };
        this.scheduleRender();
        break;
      }
      case 'tool_end': {
        const item = this.pendingTools.find((pending) => pending.id === event.id);
        const startedAt = this.toolStartedAt.get(event.id);
        if (item) {
          item.ok = event.ok;
          item.detail = event.content;
          item.durationMs = startedAt === undefined ? undefined : Math.max(0, now - startedAt);
        }
        // 与 loop 落盘的 tool_result 事件同源：下一轮请求把它注入提示词，压缩或恢复后仍看得见。
        if (!event.ok) this.lastFailure = { tool: event.name, excerpt: event.content.slice(0, 200), ts: new Date(now).toISOString() };
        this.toolStartedAt.delete(event.id);
        // 并行调用里可能还有别的在跑：指示器指向最后一个未完成的，而不是直接清空。
        const stillRunning = this.pendingTools.filter((pending) => pending.ok === undefined);
        const last = stillRunning[stillRunning.length - 1];
        this.state.activeTool = last
          ? { name: last.name, index: this.stepToolCount, total: this.stepToolCount, startedAt: this.toolStartedAt.get(last.id) ?? now }
          : undefined;
        this.refreshCounters();
        break;
      }
      case 'status': {
        const entry = this.state.entries[this.state.entries.length - 1];
        if (entry) this.commit((width) => renderEntry(entry, this.optionsAt(width)), { blank: true });
        break;
      }
      case 'error': {
        this.closeStepBlock();
        const entry = this.state.entries[this.state.entries.length - 1];
        if (entry) this.commit((width) => renderEntry(entry, this.optionsAt(width)), { blank: true });
        break;
      }
      case 'done':
        this.closeStepBlock();
        break;
      default:
        break;
    }
    this.render();
  };

  /** 把攒下的工具调用渲染成一个块写进滚动区。 */
  /** 当前进行中的步骤块：块在 thinking_start 打开，工具结果就地刷新进它。 */
  private stepBlock?: BodyBlock;
  /** 本步思考开始的时刻，用于 `Thought for 1.2s`。 */
  private thinkingStartedAt?: number;

  /**
   * 开一个步骤块：一次 LLM 调用的思考链与它发起的工具调用汇总在这里。
   * 上一块先定稿（不再每帧重排，并折回一级）。
   */
  private openStepBlock(): ToolBlockState {
    this.closeStepBlock();
    const state: ToolBlockState = {
      id: `step-block-${this.nextToolBlockId++}`,
      items: [],
      expanded: true,
    };
    const block: BodyBlock = { lines: [], width: 0, blank: true, live: true, toolBlock: state };
    block.render = (width) =>
      renderStepBlock(state.thinking, state.items, this.optionsAt(width), state.expanded, (rows) => {
        state.itemRows = rows;
      });
    this.stepBlock = block;
    this.body.push(block);
    return state;
  }

  /**
   * 步骤块定稿：折回一级（历史里一行代表整步），空块直接从历史里摘掉——
   * 留着一个零行的块只会在对话流里多出一个空行。
   */
  private closeStepBlock(): void {
    const block = this.stepBlock;
    if (!block) return;
    this.stepBlock = undefined;
    const state = block.toolBlock;
    if (state) {
      state.expanded = false;
      if (state.thinking) state.thinking.expanded = false;
      const empty = state.items.length === 0 && (state.thinking?.text.trim() ?? '') === '';
      if (empty) {
        const at = this.body.indexOf(block);
        if (at >= 0) this.body.splice(at, 1);
        this.pendingTools = [];
        this.scheduleRender();
        return;
      }
      block.live = false;
      const width = this.viewOptions().width;
      if (block.render) {
        block.lines = block.render(width);
        block.width = width;
      }
    }
    this.pendingTools = [];
    this.scheduleRender();
  }

  /** 历史回放用：把一组工具条目直接落成一个已定稿的块（不经过 live 流程）。 */
  private commitToolBlock(items: readonly ToolCallView[], blank: boolean): void {
    if (items.length === 0) return;
    const toolBlock: ToolBlockState = {
      id: `step-block-${this.nextToolBlockId++}`,
      items: [...items],
      // 回放时没有 live 阶段，直接停在有失败就看得到失败的层级。
      expanded: items.some((item) => item.ok === false),
    };
    const block: BodyBlock = { lines: [], width: 0, blank, toolBlock };
    block.render = (width) =>
      renderStepBlock(toolBlock.thinking, toolBlock.items, this.optionsAt(width), toolBlock.expanded, (rows) => {
        toolBlock.itemRows = rows;
      });
    this.body.push(block);
    this.scheduleRender();
  }

  private abortTurn(): void {
    if (!this.running) return;
    this.abort?.abort();
    this.notify('Aborting the turn…', 'warn');
    this.render();
  }

  private refreshCounters(): void {
    this.state.jobs = this.deps.jobs.list().filter((job) => job.status === 'running').length;
    this.state.todo = todoSummary(this.deps.todos.list());
  }

  // ---------------------------------------------------------------- 输出与重绘

  /**
   * 流式正文已经由 applyAgentEvent 累进 state.entries，因此不再需要「把片段直接写到终端」，
   * 只要保证承载它的块每帧按当前宽度重排，再请求一次重绘即可。
   */
  private appendStream(): void {
    const last = this.state.entries[this.state.entries.length - 1];
    if (!last || last.kind !== 'assistant') return;
    if (!this.streamBlock || this.streamBlock.entry !== last) {
      // 上一步的正文到此定稿：不再每帧重排，但宽度变化时仍会重新折行。
      this.freezeStream();
      const block: BodyBlock = {
        lines: [],
        width: 0,
        // 模型输出前留一个空行：它紧跟在 `> 用户输入` 后面，不留就只有半行的视觉间隔，
        // 读起来像同一段话被折行了。与 user / 工具块 / notice 的 blank 语义一致：
        // 每个「说话的人换了」的块前面留一行（bodyLines 会自己吃掉连续空行，不会叠加）。
        blank: true,
        live: true,
        entry: last,
        render: (width) => renderEntry(last, this.optionsAt(width)),
      };
      this.streamBlock = block;
      this.body.push(block);
    }
    this.scheduleRender();
  }

  private freezeStream(): void {
    if (!this.streamBlock) return;
    this.streamBlock.live = false;
    this.streamBlock = undefined;
  }

  /**
   * 往对话历史追加一块。
   *
   * 传进来的是「按宽度生成行」的函数而不是现成的行：宽度变化时块会重新折行，resize 之后
   * 历史不会留着旧宽度的硬折痕。宽度无关的固定内容（帮助、清单）直接传数组即可。
   */
  private commit(
    content: readonly string[] | ((width: number) => readonly string[]),
    options?: { blank?: boolean; entry?: TranscriptEntry },
  ): void {
    this.freezeStream();
    const width = this.viewOptions().width;
    const lines = typeof content === 'function' ? content(width) : content;
    if (lines.length === 0) return;
    this.body.push({
      lines,
      width,
      blank: options?.blank === true,
      entry: options?.entry,
      render: typeof content === 'function' ? content : undefined,
    });
    this.scheduleRender();
  }

  /** 按指定宽度生成渲染选项（历史重排用；高度对正文渲染没有影响）。 */
  private optionsAt(width: number): ViewOptions {
    return { width, height: this.terminal.size().height, styler: this.styler };
  }

  /**
   * 对话框正文的可用列数：与 renderLive 里的折行宽度同源（`width - 2` 让给「> 」）。
   * 上下键按视觉行移动，必须和渲染时用同一个宽度，否则折点对不上、一次跳半屏。
   */
  private composerTextWidth(): number {
    return Math.max(1, liveWidth(this.terminal.size().width) - 2);
  }

  private viewOptions(): ViewOptions {
    const size = this.terminal.size();
    return { width: liveWidth(size.width), height: size.height, styler: this.styler };
  }

  /**
   * 清空对话历史视图（Ctrl+L / /clear）。
   *
   * 全屏模式下「清屏」不再是往终端发一个清屏序列——整帧绘制本来就每帧覆盖一整屏，
   * 真正要清掉的是 body[] 里的历史块。会话记录不受影响，`/export` 仍能拿到完整内容。
   */
  private clearBody(): void {
    this.body.length = 0;
    this.streamBlock = undefined;
    this.state.scroll = 0;
    this.render();
  }

  /** 历史全部行；同时保留用户消息区间，供滚动视口计算吸顶标题。 */
  private bodyLines(width: number): BodySnapshot {
    const out: string[] = [];
    const userPrompts: UserPromptRegion[] = [];
    const toolBlocks: ToolBlockHit[] = [];
    for (const block of this.body) {
      if (block.render && (block.live === true || block.width !== width)) {
        block.lines = block.render(width);
        block.width = width;
      }
      if (block.blank === true && out.length > 0 && out[out.length - 1] !== '') out.push('');
      const start = out.length;
      out.push(...block.lines);
      if (block.entry?.kind === 'user' && block.lines.length > 0) {
        userPrompts.push({ start, end: out.length, lines: block.lines });
      }
      if (block.toolBlock && block.lines.length > 0) {
        toolBlocks.push({ start, end: out.length, id: block.toolBlock.id, block });
      }
    }
    return { lines: out, userPrompts, toolBlocks };
  }

  /** 合并同一时刻的多次重绘请求：流式正文可能在一个事件循环里来好几段。 */
  private scheduleRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  private render(): void {
    if (!this.terminal.active) return;
    this.refreshBranch(Date.now());
    const size = this.terminal.size();
    const options: ViewOptions = { width: liveWidth(size.width), height: size.height, styler: this.styler };
    // 改宽度会让正文整体重新折行，选区的内容坐标随之失效——这是唯一需要提前清掉它的时机
    // （滚动、追加内容都不会让下标漂移，所以那些情况下一律保留）。
    if (size.width !== this.lastSize.width) this.state.selection = undefined;
    this.lastSize = { width: size.width, height: size.height };
    const live = renderLive(this.state, options);
    const snapshot = this.bodyLines(options.width);
    const body = snapshot.lines;
    // 滚动锚定：视口上方长高时把偏移同步推上去（见 anchorScroll 的两条边界）。
    // 新提交的行也走这一条路径，不再由 commit 记账，否则两条路径会重复累加。
    this.state.scroll = anchorScroll(this.state.scroll, this.lastBodyLength, body.length);
    this.lastBodyLength = body.length;
    const header = renderHeader(this.state, options);
    const pinnedPrompt = this.pinUserPrompt ? snapshot.userPrompts[snapshot.userPrompts.length - 1] : undefined;
    let reservePrompt = this.reserveUserPrompt ? snapshot.userPrompts[snapshot.userPrompts.length - 1] : undefined;
    let frame = composeFrame(header, body, live, options, this.state.scroll, this.state, snapshot.userPrompts, snapshot.toolBlocks);
    let frameBody: readonly string[] = body;
    if (reservePrompt) {
      // 最新用户消息刚提交时，回复还没有足够行数把它顶到视口顶部；补一段仅用于视口计算的尾部空白，
      // 让这条消息可以立即翻到顶部。真实内容增长后空白会自然缩短，回复始终从它下面展开。
      const reserve = Math.max(0, reservePrompt.start + frame.body.rows - body.length);
      if (reserve > 0) frameBody = [...body, ...new Array<string>(reserve).fill('')];
      const virtualEnd = frameBody.length - this.state.scroll;
      if (!this.pinUserPrompt && this.state.scroll > 0 && virtualEnd <= reservePrompt.start) {
        this.reserveUserPrompt = false;
        reservePrompt = undefined;
        frameBody = body;
      }
    }
    // 夹住偏移：优先使用吸顶预留后的高度，避免手动回看被真实尾部提前夹回去。
    this.state.scroll = Math.max(0, Math.min(this.state.scroll, maxScroll(frameBody.length, live, size.height)));
    frame = composeFrame(header, frameBody, live, options, this.state.scroll, this.state, snapshot.userPrompts, snapshot.toolBlocks);
    if (pinnedPrompt) {
      // 按当前真实对话流高度计算目标偏移；这样浮层出现或窗口变化时，用户消息仍保持在顶部。
      const target = Math.max(0, frameBody.length - frame.body.rows - pinnedPrompt.start);
      const max = Math.max(0, frameBody.length - frame.body.rows);
      const nextScroll = Math.min(target, max);
      if (nextScroll !== this.state.scroll) {
        this.state.scroll = nextScroll;
        frame = composeFrame(header, frameBody, live, options, nextScroll, this.state, snapshot.userPrompts, snapshot.toolBlocks);
      }
    }
    // 对话流的实际行数由布局分配给出（framebody），页面大小必须与它一致。
    this.lastBodyRows = Math.max(1, frame.lines.length - live.lines.length);
    // 滚轮命中判断用**帧内真实区间**：浮层压上来时它会自动变矮。
    this.lastBodyRegion = frame.body;
    this.lastToolBlocks = snapshot.toolBlocks;
    this.lastFrameToolBlocks = frame.toolBlocks;
    this.lastBody = body;
    this.terminal.paint(frame.lines, frame.cursor);
  }

  /**
   * 分支可能被外部 `git checkout` 改掉，但状态行在运行中每 120ms 重绘一次，
   * 不可能每帧读盘 —— 2 秒一次足够新，代价可以忽略。
   */
  private refreshBranch(now: number): void {
    if (now - this.lastBranchCheck < BRANCH_TTL_MS) return;
    this.lastBranchCheck = now;
    const branch = readGitBranch(this.deps.workspaceRoot);
    if (branch !== this.state.branch) this.state.branch = branch;
  }

  private startSpinner(): void {
    if (this.spinnerTimer) return;
    this.spinnerTimer = setInterval(() => {
      this.state.spinner++;
      this.render();
    }, 120);
  }

  private stopSpinner(): void {
    if (!this.spinnerTimer) return;
    clearInterval(this.spinnerTimer);
    this.spinnerTimer = undefined;
  }

  /**
   * 窗口尺寸变化。
   *
   * 整帧覆盖绘制对 resize 天然正确：终端重排留在屏幕上的只是旧像素，下一次整帧绘制会逐行
   * 清掉重写，不可能像之前的相对光标实现那样叠出几十份残影。所以这里不需要任何「擦除 /
   * 重置记账」动作，也不需要重新初始化什么——只要限流地重绘。
   */
  private handleResize(): void {
    const size = this.terminal.size();
    if (size.width === this.lastSize.width && size.height === this.lastSize.height) return;
    const now = Date.now();
    if (now - this.lastResizePaint >= RESIZE_MIN_INTERVAL_MS) {
      this.lastResizePaint = now;
      this.render();
      return;
    }
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = undefined;
      this.lastResizePaint = Date.now();
      this.render();
    }, RESIZE_MIN_INTERVAL_MS);
  }

  // ---------------------------------------------------------------- ApprovalUi

  approvalMode(): ApprovalMode {
    return this.approvalModeValue;
  }

  requestApproval(request: ApprovalRequest, note?: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.state.prompt = { kind: 'approval', request, note, choice: 'allow', resolve };
      this.state.phase = 'approval';
      this.render();
    });
  }

  requestAnswer(question: string, initial = ''): Promise<string> {
    return new Promise<string>((resolve) => {
      this.state.prompt = { kind: 'ask', question, editor: initial === '' ? emptyEditor() : setText(initial), resolve };
      this.state.phase = 'ask';
      this.render();
    });
  }

  /**
   * 多字段表单浮层。确认时回传各字段文本，取消（Esc）回传 undefined —— 注意是
   * `undefined` 而不是空对象：调用方据此区分「用户取消」与「用户什么都没改就确认」，
   * 前者不应用任何更改，后者按填写的值应用。
   */
  requestForm(spec: FormSpec): Promise<Record<string, string> | undefined> {
    return new Promise((resolve) => {
      this.state.prompt = {
        kind: 'form',
        title: spec.title,
        note: spec.note,
        fields: spec.fields.map((field) => ({
          key: field.key,
          label: field.label,
          editor: field.value === '' ? emptyEditor() : setText(field.value),
          placeholder: field.placeholder ?? '',
        })),
        focus: 0,
        validate: spec.validate,
        resolve,
      };
      this.state.phase = 'form';
      this.render();
    });
  }

  requestPlan(plan: string): Promise<{ approved: boolean; feedback?: string }> {
    return new Promise((resolve) => {
      this.state.prompt = { kind: 'plan', plan, editor: emptyEditor(), resolve };
      this.state.phase = 'plan';
      this.render();
    });
  }
}

/** `/name args` → { name, args }；不是命令形状时返回 undefined。 */
function parseSlashInput(text: string): { name: string; args: string } | undefined {
  const match = /^\/(\S+)\s*([\s\S]*)$/.exec(text);
  if (!match) return undefined;
  return { name: match[1].toLowerCase(), args: match[2].trim() };
}

/**
 * 编辑器按键映射；返回 undefined 表示该键不是编辑动作。
 *
 * `width` 只有上下键用得到：对话框能显示多行，上下键按**视觉行**移动（而不是硬换行），
 * 所以需要知道当前宽度才能算出折行位置。上下键在空闲态另作历史回溯，见 handleIdleKey。
 *
 * `Ctrl+J` 是换行键：对话框中 Enter 归「发送」，换行只能让给别的组合键。选 Ctrl+J 是因为
 * 它就是 LF 本身——终端把 Enter 发成 CR（`\r`）、把 Ctrl+J 发成 LF（`\n`）时二者天然可分。
 */
function applyEditorKey(editor: EditorState, key: Key, width: number): EditorState | undefined {
  switch (key.kind) {
    case 'text':
      return insertText(editor, key.text);
    case 'paste':
      return insertText(editor, key.text);
    case 'backspace':
      return backspace(editor);
    case 'delete':
      return deleteForward(editor);
    case 'left':
      return moveLeft(editor);
    case 'right':
      return moveRight(editor);
    case 'home':
      return moveHome(editor);
    case 'end':
      return moveEnd(editor);
    case 'up':
      return moveUp(editor, width);
    case 'down':
      return moveDown(editor, width);
    case 'ctrl':
      if (key.key === 'a') return moveHome(editor);
      if (key.key === 'e') return moveEnd(editor);
      if (key.key === 'j') return newline(editor);
      if (key.key === 'k') return killToEnd(editor);
      if (key.key === 'u') return killToStart(editor);
      if (key.key === 'w') return killWordBefore(editor);
      if (key.key === 'b') return moveLeft(editor);
      if (key.key === 'f') return moveRight(editor);
      return undefined;
    default:
      return undefined;
  }
}

/** 表单浮层的规格：由调用方给出字段与校验，弹窗本身不认识具体业务含义。 */
interface FormSpec {
  title: string;
  note?: string;
  fields: readonly FormFieldSpec[];
  /** 返回非空字符串表示校验不通过（内容即错误提示），此时弹窗保持打开、内容不丢。 */
  validate?: (values: Record<string, string>) => string | undefined;
}

interface FormFieldSpec {
  key: string;
  label: string;
  /** 初始值（通常填默认值）；填空串则显示 placeholder。 */
  value: string;
  placeholder?: string;
}

/**
 * 表单字段是单行输入：换行在这里没有业务含义，粘贴进来的换行压成空格——留着会让渲染按
 * 单行算、而编辑器按多行算，光标列立刻错位。
 */
function applyFieldKey(editor: EditorState, key: Key, width: number): EditorState | undefined {
  if (key.kind === 'ctrl' && key.key === 'j') return undefined;
  if (key.kind === 'text' || key.kind === 'paste') {
    return insertText(editor, key.text.replace(/\s*\n\s*/g, ' '));
  }
  return applyEditorKey(editor, key, width);
}

/** 上下文窗口的下限：低于它没有真实模型可用，多半是把单位写错了（比如把 256000 写成 256）。 */
const MIN_CONTEXT_WINDOW = 1_000;

/** 输出上限的下限：0 没法用。 */
const MIN_MAX_TOKENS = 1;

/**
 * 模型向导第 2 步的校验：两个数值各自合法，且**互相自洽**。
 *
 * 只接受十进制整数，不接受 `256k` / `8m` 这类后缀：写进 config.toml 的本来就是整数，让用户
 * 在这里做一次单位换算，等于把「256k 到底是 256000 还是 262144」这种歧义塞进配置里。
 *
 * 交叉校验是另一条值钱的检查——输出上限大于上下文窗口的请求，上游一定会拒绝；等到真正发请求
 * 时才报错，用户已经走完整个向导了。
 */
function validateModelLimits(values: Record<string, string>): string | undefined {
  const contextWindow = parseTokenCount(values.context_window ?? '');
  if (contextWindow === undefined) {
    return 'Context window must be a decimal integer, without a k/m suffix (write 256k as 256000).';
  }
  if (contextWindow < MIN_CONTEXT_WINDOW) {
    return `Context window must be at least ${MIN_CONTEXT_WINDOW}; you entered ${contextWindow}.`;
  }
  const maxTokens = parseTokenCount(values.max_tokens ?? '');
  if (maxTokens === undefined) {
    return 'Max output tokens must be a decimal integer, without a k/m suffix (write 8k as 8192).';
  }
  if (maxTokens < MIN_MAX_TOKENS) {
    return `Max output tokens must be at least ${MIN_MAX_TOKENS}; you entered ${maxTokens}.`;
  }
  if (maxTokens > contextWindow) {
    return `Max output tokens cannot exceed the context window (${contextWindow}).`;
  }
  return undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 严格解析十进制整数：只认 `^\d+$`。
 *
 * 刻意不走 `Number()` 的宽松解析——它会把 `0x10`、`1e3`、`12.0`、` 12 ` 都收下，而表单里多接受
 * 一种写法，用户就多一次「为什么这么写也行/不行」的困惑。
 */
function parseTokenCount(input: string): number | undefined {
  const text = input.trim();
  if (!/^\d+$/.test(text)) return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : undefined;
}

function displayBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[configured upstream URL]';
  }
}
