/**
 * 交互模式的装配与调度。
 *
 * 结构对应参考实现 pi 的 modes/interactive/interactive-mode.ts：
 *   - 文档容器（header + chat）放进 ScrollView，固定在底部的 dock 由
 *     「pending / status / editor / footer」垂直堆叠（见 createChatViewport 的等价实现）；
 *   - 全屏（替代屏幕）模式用 VStack 约束布局，主屏模式则按顺序 addChild 成一份纵向文档；
 *   - agent 事件 → 对话块（用户块 / 助手块 / 工具块 / 状态行）；
 *   - 审批、提问通过浮层对话框完成，浮层用 Promise 把结果回给等待中的 agent 调用。
 *
 * 与参考实现的差异来自运行时的不同：sph 的 agent 核心是 runTurn + AgentListener，
 * 因此这里的事件投影、会话回放与命令集都按 sph 的语义实现，交互形态保持一致。
 */

import { join } from 'node:path';
import type { AgentListener, SubagentEvent } from '../agent/events.js';
import { loadCompaction, projectContext } from '../agent/compact.js';
import { loadUserTheme } from './theme/theme.js';
import { sphModelsPath, sphThemePath } from '../home.js';
import { visibleWidth } from './core/utils.js';

import { exportHtml, exportJson, exportMarkdown } from '../session/export.js';
import { createSteeringInbox, STEERING_QUEUE_LIMIT, type SteeringInbox } from '../runtime/jobs.js';
import { runTurn, type AgentDriver } from '../agent/loop.js';
import { TouchMemory } from '../agent/memory.js';
import { buildSystemPrompt, isSessionStateMessage } from '../agent/prompt.js';
import {
  AUTO_RECAP_RETRY_MS,
  RECAP_IDLE_MS,
  RECAP_WATCH_INTERVAL_MS,
  generateRecap,
  mainTurnCount,
  recapGate,
  shouldSuppressAutoRecapDisplay,
  type RecapContext,
} from '../agent/recap.js';
import { scanSkills, skillRoots } from '../skills/scan.js';
import { createLlmClassifier } from '../permission/auto.js';
import { APPROVAL_MODES, HeadlessApprover, type ApprovalMode, type ApprovalRequest, type Approver, type PermissionRules, type SubagentApprovalPolicy } from '../permission/policy.js';
import { createGrantStore } from '../permission/store.js';
import { updateConfigFile } from '../config/save.js';
import { removeSphMcpServer, setSphMcpPreference, splitCommandLine, upsertSphMcpServer } from '../config/mcp-write.js';
import { API_PROTOCOLS, type ApiProtocol } from '../config/load.js';
import { appendModelDeclaration, splitProviderModel, upsertModelApi, type ProviderDeclaration, type ResolvedModel } from '../config/registry.js';
import {
  REASONING_EFFORTS,
  type LlmClient,
  type ReasoningEffort,
  type TokenUsage,
} from '../llm/openai.js';
import { displayNameForModel, listAvailableModels } from '../llm/models.js';
import type { McpHub, McpReloadResult } from '../mcp/hub.js';
import type { McpPreferences, McpSourceReport } from '../mcp/sources.js';
import type { JobBoard } from '../runtime/jobs.js';
import { jobNotificationText } from '../runtime/jobs.js';
import type { WorktreeStore } from '../runtime/worktrees.js';
import { SpillStore } from '../runtime/spill.js';
import type { TodoList } from '../runtime/todos.js';
import type { SandboxHandle } from '../sandbox/types.js';
import {
  foldSessionState,
  sessionEventData,
  type SessionFailure,
} from '../session/fold.js';
import { messagesOf } from '../session/query.js';
import {
  createSession,
  jsonlSessionFactory,
  JsonlSession,
  listSessions,
  setCurrentSession,
} from '../session/store.js';
import type { SessionFactory } from '../session/types.js';
import { defaultTools, type ToolRegistry } from '../tools/index.js';
import { closeInterruptedTurn } from '../session/repair.js';
import type { SessionMessage, SessionRecord } from '../session/types.js';
import {
  BLOCK_GAP,
  CombinedAutocompleteProvider,
  Container,
  type Component,
  isKeyRelease,
  matchesKey,
  isViewportTUI,
  type SelectItem,
  type SlashCommand,
  Spacer,
  Text,
  type TUI,
  TuiAltScreen,
  ProcessTerminal,
  type Terminal,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  VStack,
  ScrollView,
} from './core/index.js';
import { matchesAppKey } from './app-keybindings.js';
import { InteractiveApprover, type ApprovalUi } from './permission.js';
import { showConfirmDialog, showInputDialog, showLoadingDialog, showMessageDialog, showSelectDialog } from './dialogs.js';
import { mcpStateLabel, renderMcpReport, renderMcpTools, renderSkillsReport } from './reports.js';
import { readGitBranch } from './git.js';
import { AssistantMessageComponent } from './components/assistant-message.js';
import { CustomEditor } from './components/custom-editor.js';
import { FooterComponent, type FooterData } from './components/footer.js';
import { HeaderComponent } from './components/header.js';
import {
  DynamicBorder,
  IdleStatus,
  WorkingLabel,
  WorkingStatusIndicator,
  formatWorkingWarning,
  keyHint,
  workingWarningKey,
} from './components/interaction.js';
import { handleSelectablePress } from './components/selectable-row.js';
import { clearHoverHighlight } from './components/hover-highlight.js';
import { TOOL_GROUP_INDENT, TOOL_MEMBER_INDENT, ToolExecutionComponent, summarizeArgs, toolDisplayName } from './components/tool-execution.js';
import { SubagentTaskComponent } from './components/subagent-task.js';
import { ToolGroupComponent } from './components/tool-group.js';
import { UserMessageComponent } from './components/user-message.js';
import { userMessageBubbleY } from './components/sticky-user-message.js';
import { RecapMessageComponent } from './components/recap.js';
import { getEditorTheme, getMarkdownTheme, theme } from './theme/theme.js';
import { errorMessage, flattenWhitespace, formatDuration } from '../util.js';
import { readVersion } from '../version.js';

export interface TuiDeps {
  workspaceRoot: string;
  sessionDir: string;
  /** config.toml 路径：/model、/effort、/permission 的选择写回这里，下次启动仍生效。 */
  configPath: string;
  /** 欢迎态底部右对齐的登录状态文案（API key / 免鉴权头）。 */
  authLabel: string;
  /** config.toml 里生效的 provider 名（models.json 的声明之一）。 */
  providerName: string;
  /** models.json 的 provider 声明；/model 列表从这里来（不再拉上游）。 */
  models(): readonly ProviderDeclaration[];
  /** 按模型 id（可指定 provider）解析生效协议与容量声明。 */
  resolveModel(model: string, provider?: string): ResolvedModel;
  contextWindow: number;
  maxTokens?: number;
  sandbox: SandboxHandle;
  session: JsonlSession;
  mcp: McpHub;
  /**
   * 重新发现并装载 MCP server（`/mcps` 里按 r、改完启停、或导入之后调用）。
   *
   * 必需：启动时的首次装载与这里的刷新走的是同一条装配路径，缺了它就只能重启——
   * 而「改完配置要重启」正是这轮要消掉的那件事。
   */
  reloadMcp(): Promise<McpReloadResult>;
  /** 重新读 `[mcp]` 偏好段；写回 config.toml 之后调用。 */
  refreshMcpPreferences(): void;
  /** 生效中的 MCP 启停偏好，供弹窗显示当前状态。 */
  mcpPreferences: McpPreferences;
  /** 最近一次发现的候选来源读取结果。 */
  mcpSources(): readonly McpSourceReport[];
  todos: TodoList;
  jobs: JobBoard;
  approvalMode: ApprovalMode;
  /** `[permissions]` 规则；省略即无规则。 */
  permissionRules?: PermissionRules;
  /** 子代理审批策略；省略按 inherit。 */
  subagentApproval?: SubagentApprovalPolicy;
  model: string;
  effort?: ReasoningEffort;
  /** /model 与 /effort 改动后按新参数重建 client；api 省略时由 provider 声明按模型解析。 */
  makeClient(options: { model: string; provider?: string; api?: ApiProtocol; effort?: ReasoningEffort; maxTokens?: number }): LlmClient;
  /**
   * 辅助调用（压缩摘要 / auto 审查器）的 client；模型名省略时返回 undefined。
   *
   * 必需而非可选：此前这条线没接上，配置了 `compact_model` / `review_model` 也一直用主模型，
   * 是个静默失效的省钱开关。做成必需，调用方漏接就编译不过。
   */
  makeAuxClient(model: string | undefined): LlmClient | undefined;
  /** CLI 显式给了 --model：启动时不被会话里记录的模型覆盖。 */
  modelPinned?: boolean;
  /** 压缩摘要 / auto 审批审查器专用模型；省略都回退主模型。 */
  compactModel?: string;
  reviewModel?: string;
  /** spill 落盘根目录。 */
  spillRoot?: string;
  spillThreshold?: number;
  /** 子代理嵌套深度预算（config.subagent_max_depth）；省略用内置默认 1（扁平）。 */
  maxSubagentDepth?: number;
  /** 会话累计 token 预算（config.max_session_tokens）；省略或 0 = 不限制。 */
  maxSessionTokens?: number;
  /** 子代理 worktree 隔离的工作树仓库（isolation: worktree 用）。 */
  worktrees?: WorktreeStore;
  /** 把会话锁换到另一个 id；失败时抛错，当前会话仍占用。 */
  claimSession?(id: string): void;
  /** 可注入工具表 / 会话工厂 / 驱动；省略走产品默认。 */
  tools?: ToolRegistry;
  sessions?: SessionFactory;
  driver?: AgentDriver;
  /** 注入终端实现；省略用 ProcessTerminal（测试用假终端驱动整条链路）。 */
  terminal?: Terminal;
  /**
   * 已经 start 过的 TUI。信任页会先占用同一块替代屏幕，主界面接手后不得再 start。
   * 省略则本模块自己创建并 start。
   */
  ui?: TUI;
  /** MCP 启动警告；在 TUI 里用通知展示，避免写 stderr 打穿替代屏幕。 */
  mcpWarnings?: readonly string[];
}

interface CommandItem {
  id: string;
  label: string;
  hint: string;
}

const COMMANDS: readonly CommandItem[] = [
  { id: 'help', label: '/help', hint: 'List commands and key bindings' },
  { id: 'new', label: '/new', hint: 'Start a new session' },
  { id: 'resume', label: '/resume', hint: 'Resume a previous session, or switch by id' },
  { id: 'skills', label: '/skills', hint: 'List the skills this workspace advertises' },
  { id: 'mcps', label: '/mcps', hint: 'Manage MCP servers: status, enable/disable, add, remove, reload' },
  { id: 'plan', label: '/plan', hint: 'Enter plan mode, or /plan off to leave' },
  { id: 'goal', label: '/goal', hint: 'Set, view, or clear the goal' },
  { id: 'compact', label: '/compact', hint: 'Compact older history into a checkpoint, optionally with focus instructions' },
  { id: 'model', label: '/model', hint: 'Choose a model and write it to config.toml' },
  { id: 'provider', label: '/provider', hint: 'Switch provider, then model, reasoning effort, and API protocol' },
  { id: 'effort', label: '/effort', hint: 'Set reasoning effort (written to config.toml)' },
  { id: 'permission', label: '/permission', hint: 'Set the approval mode: ask | auto | yolo' },
  { id: 'export', label: '/export', hint: 'Export this session as markdown, json, or html' },
];

/**
 * 别名 → 正名。正名进菜单（`/help`、Ctrl+P 命令面板），别名只保证还能敲。
 *
 * 这条分工照抄 grok-build：那边的 `/resume` 是会话选择器的正名，`/sessions` 留作
 * 老习惯的重定向。sph 早先只有 `/sessions`，名字留下是因为肌肉记忆和已经写进会话
 * 记录的文本里都是它；新名字与 CLI 的 `sph --resume` 对齐。
 */
const COMMAND_ALIASES: Readonly<Record<string, string>> = { sessions: 'resume' };

/** 选择列表里 server 条目的 value 前缀，避免和上方的固定动作条目撞名。 */
const SERVER_PREFIX = 'server:';

const COMMAND_NAMES = new Set<string>([
  ...COMMANDS.map((command) => command.id),
  ...Object.keys(COMMAND_ALIASES),
  'exit',
]);

function message(error: unknown): string {
  return errorMessage(error);
}

/** 输入框上方子代理栏最多显示几行，多出来的折成 `… N more`。 */
const MAX_DOCK_SUBAGENT_ROWS = 5;
/** 挂起条行右缘预留（4 列 = 1 列滚动条 + 空两格，与状态行 Loader 同款，右缘同列）。 */
const STEER_RIGHT_PAD = 4;
/** 挂起条首行上方的空行间距；鼠标 y 换算行下标时要扣掉它。 */
const STEER_TOP_GAP = 1;
/** 悬停/焦点行动作按钮链（从右往左紧贴无缝，宽不够整颗放弃）。 */
const STEER_BUTTONS: Array<{ action: SteerAction; label: string }> = [
  { action: 'cancel', label: '[cancel]' },
  { action: 'edit', label: '[edit]' },
  { action: 'send', label: '[Send now]' },
];

type SteerAction = 'cancel' | 'edit' | 'send';
/** `/provider` 拉上游目录的超时。刻意短：不少中转站根本没有 /models 目录端点（返回 502 或干脆挂住），走代理时 CONNECT 隧道也会拖很久。目录只是发现手段，降级路径（已声明 + 手动输入）才是兜底。 */
const PROVIDER_FETCH_TIMEOUT_MS = 10_000;

/**
 * 斜杠命令弹窗的主列（label 列）宽度：最宽 label + 2 列间隙，下限 8。
 *
 * SelectList 默认 32 列是给「命令表 + 长提示」这类排版用的；对 label 很短的菜单
 * （ask / yolo / effort 档位）会让 description 拖出一大段空白。统一自适应后各弹窗
 * 的列都贴内容，视觉一致。
 */
function primaryColumnWidthFor(items: readonly SelectItem[]): number {
  const widest = items.reduce((max, item) => Math.max(max, visibleWidth(item.label)), 0);
  return Math.max(widest, 8) + 2;
}

/**
 * 子代理内部事件 → 行内活动段文案，与底部状态行共用同一套词（WorkingLabel）。
 *
 * 返回 undefined 表示这个事件不改变活动段（`tool_end` / `status` / `thinking_start` 不改）。
 * thinking_start 每轮都会发，但很多端点不吐 reasoning，不能一开就切到 Thinking…。
 */
function subagentActivity(event: SubagentEvent): string | undefined {
  switch (event.type) {
    case 'thinking_delta':
      return WorkingLabel.thinking;
    case 'thinking_end':
      return WorkingLabel.working;
    case 'text':
      return WorkingLabel.responding;
    case 'tool_start':
      return WorkingLabel.running(toolDisplayName(event.name), summarizeArgs(event.name, event.args));
    case 'error':
      return flattenWhitespace(event.text).slice(0, 80);
    default:
      return undefined;
  }
}

/** 交互模式入口。 */
export async function runTui(deps: TuiDeps): Promise<void> {
  loadUserTheme(sphThemePath());
  const mode = new InteractiveMode(deps);
  await mode.run();
}

class InteractiveMode implements ApprovalUi {
  private readonly deps: TuiDeps;
  private readonly ui: TUI;
  private readonly editor: CustomEditor;

  private readonly headerContainer = new Container();
  private readonly chatContainer = new VStack();
  private readonly documentContainer = new VStack();
  private readonly pendingContainer = new Container();
  /** 挂起条专属容器：工作状态行之下、输入框之上——排队的话紧贴着要发送的位置。 */
  private readonly steersContainer = new Container();
  private readonly subagentContainer = new Container();
  private readonly subagentHeader = new Text('', 0, 0);
  private readonly statusContainer = new Container();
  private readonly editorContainer = new Container();
  private readonly footerContainer = new Container();
  private transcriptView: ScrollView | undefined;
  private readonly idleStatus = new IdleStatus(() => this.ui?.requestRender());
  private readonly footer: FooterComponent;
  private readonly header: HeaderComponent;

  private session: JsonlSession;
  private client: LlmClient;
  private readonly turnInbox: SteeringInbox = createSteeringInbox();
  /**
   * 运行中输入的挂起条：每帧从 turnInbox 动态渲染，队列空即零占用。
   * 渲染进 steersContainer（工作状态行之下、输入框之上）；容器 shrink 弹性，
   * 行数多时先压它。行内交互（悬停按钮/双击取回）见 onSteersMouse，键盘见 onQueueNav。
   */
  private readonly steersBar: Component = {
    invalidate: () => {},
    render: (width: number) => this.renderPendingSteers(width),
    handleMouse: (event) => this.onSteersMouse(event),
  };
  private followUps: string[] = [];
  /** 挂起队列的选中项下标：↑↓/J/K 与悬停的作用对象；文字加粗亮色标识。 */
  private steerCursor?: number;
  /** 队列焦点态：编辑器按 ↑ 进入后，↑↓/⇧J/⇧K/Enter/e/x/Delete/Esc 归队列面板（grok-build 同款）。 */
  private steerFocus = false;
  /** 鼠标悬停的挂起消息下标：该行铺极浅底并亮出动作按钮，移出即隐藏。 */
  private steerHover?: number;
  /** 悬停中的动作按钮：按钮文字按动作变色（cancel 红、edit/send 亮）。 */
  private steerButtonHover?: { row: number; action: SteerAction };
  /** 本帧渲染出的按钮命中区（组件局部坐标，x 为半开区间 [x0, x1)，y = row + STEER_TOP_GAP）。 */
  private steerButtons: Array<{ row: number; action: SteerAction; x0: number; x1: number }> = [];
  /**
   * 双击编辑占位：既是取回消息的原排序位（提交后插回，而不是排到队尾），也是投递
   * 冻结标志——非空期间轮末自动发送与立即发送全部让路，其余挂起消息等编辑提交后
   * 按序消化。
   */
  private steerEditIndex?: number;
  private readonly approver: InteractiveApprover;
  /** `subagent_approval = "strict"` 时的子代理审批器；inherit 时 undefined（复用 approver）。 */
  private readonly subagentApprover?: Approver;
  /** 压缩摘要专用 client（config.compact_model）；未配置为 undefined，runTurn 回退主 client。 */
  private readonly compactClient?: LlmClient;
  /** auto 审批审查器专用 client（config.review_model）；未配置为 undefined。 */
  private readonly reviewClient?: LlmClient;

  private model: string;
  /** 当前 provider：/model 选到其它 provider 的模型时会一起切换。 */
  private provider: string;
  private effort?: ReasoningEffort;
  private maxTokens?: number;
  private approval: ApprovalMode;
  private contextWindow: number;
  private goal?: string;
  private lastFailure?: SessionFailure;
  /** 与 runTurn 共享同一对象，工具进出计划模式会原地翻转。 */
  private readonly plan = { active: false };
  private gitBranch?: string;

  private running = false;
  private quitting = false;
  private abort?: AbortController;
  private quitResolve?: () => void;
  private lastSigintAt = 0;
  private lastSigintTimer?: NodeJS.Timeout;

  private streamingAssistant?: AssistantMessageComponent;
  private thinkingId?: string;
  /**
   * 承载当前思考链的工具分组。
   *
   * 思考期间可能插进正文（`thinking_end` 在正文之后才广播），而正文会断开当前分组，
   * 所以收尾时不能重新 `ensureToolGroup()`——认住开始时那个组，同一段推理才不会被劈成两半。
   */
  private thinkingGroup?: ToolGroupComponent;
  /** 本段思考链的起点，用来给收尾文案算 `Thought for 1.2s`。 */
  private thinkingStartedAt?: number;
  /**
   * 本轮模型是否已经真正响应（思考/正文/工具）。
   * 不能用「助手组件是否已创建」代替：`thinking_start` 在请求发出前就会广播。
   * stream_retry 会丢掉半截画面，但一旦响应过就不能再把原文塞回输入框
   * （对齐 grok in_flight_prompt 在 first activity 后作废）。
   */
  private modelResponded = false;
  /** 本轮可 rewind 的用户原文；后台唤醒注入的通知不能塞回输入框。 */
  private inFlightPrompt?: string;
  /** 取消时把原文放回输入框（等 abort 收尾后再做，避免和 thinking_start 抢）。 */
  private pendingRewind?: string;
  /**
   * 立即发送的待投内容：挂起队列在 turn 运行中触发「现在就发」时，先中断当前轮，
   * 轮次收尾（finally）里以这段合并文本立即开新一轮。仅在 sendQueuedNow 设置。
   */
  private sendAfterInterrupt?: string;
  private readonly pendingTools = new Map<string, ToolExecutionComponent>();
  private readonly toolGroups: ToolGroupComponent[] = [];
  /** 当前正在累积的工具分组；助手正文/通知/轮次结束都会把它断开。 */
  private activeToolGroup?: ToolGroupComponent;
  private subagentDepth = 0;
  /** 本组内 subagent 调用的序号（行首的 `Subagent 1`）；分组断开时归零。 */
  private subagentOrdinal = 0;
  /** 会话的持久化深度下限（resume 恢复），本轮 runTurn 从这里起步。 */
  private sessionDepth = 0;
  /**
   * 子代理 id → 主流程里对应的 Task 工具行 + 转录内实时任务块。
   *
   * 子代理的内部活动（工具调用、错误）实时刷进任务块（Claude Code 式），聚合结果在
   * subagent_end 时写到 Task 行的活动后缀上，随后任务块整块撤除、不在时间线常驻。
   * 后台任务的工具行在 job id 返回时就已完成，所以这里独立于 pendingTools 持有引用。
   */
  private readonly subagentLines = new Map<
    string,
    {
      tool: ToolExecutionComponent;
      description: string;
      toolCallId?: string;
      background: boolean;
      /** 回放路径不建实时块（内部调用明细不落主会话），只有汇总。 */
      live?: SubagentTaskComponent;
    }
  >();


  private usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
  private contextTokens?: number;
  private readonly history: string[] = [];

  /**
   * Recap 状态。
   *
   * `lastRecapMainTurn` 是水印（上次 recap 覆盖到第几个主轮次），来自会话事件折叠——
   * 必须活过持久化，否则重启一次就会把同一段会话再 recap 一遍。
   * `lastActivityAt` 是空闲计时起点（轮次收尾时刷新）：sph 的输入层没有终端焦点上报，
   * 「用户离开过」用空闲时长近似（参考实现用 FocusTracker 的 lost_at）。
   * `recapEpoch` 在每轮开始时自增：生成期间来了新 prompt 就丢弃这次 recap 的展示。
   */
  private lastRecapMainTurn = 0;
  private lastActivityAt = Date.now();
  private recapInFlight = false;
  private recapEpoch = 0;
  private recapTimer?: NodeJS.Timeout;
  /** 自动 recap 的下一次尝试时间（退避）；闸门常被拒，不该每轮轮询都重读会话文件。 */
  private recapRetryAfter = 0;
  private pendingRecap?: RecapMessageComponent;

  constructor(deps: TuiDeps) {
    this.deps = deps;
    this.session = deps.session;
    this.model = deps.model;
    this.provider = deps.providerName;
    this.effort = deps.effort;
    this.maxTokens = deps.maxTokens;
    this.approval = deps.approvalMode;
    this.contextWindow = deps.contextWindow;
    // 挂起条构造即入容器占位：队列空时零占用，不影响布局。
    this.steersContainer.addChild(this.steersBar);

    this.client = this.buildClient();
    // 辅助 client 必须在这里建好：下面构造审批器时要用 reviewClient，runTurn 时要用 compactClient。
    this.compactClient = deps.makeAuxClient(deps.compactModel);
    this.reviewClient = deps.makeAuxClient(deps.reviewModel);
    this.approver = new InteractiveApprover(
      this,
      this.approval === 'auto'
        ? createLlmClassifier(this.reviewClient ?? this.client, {
            onUsage: (usage) => this.recordAuxUsage(usage, 'review'),
          })
        : undefined,
      // 作用域在构造时解析一次：工作区根在一次进程里不会变。
      createGrantStore(deps.workspaceRoot),
      deps.permissionRules,
    );
    // `strict` 子代理的审批器：fail-closed，不弹窗，也不共享父会话攒下的授权集合。
    // 在构造时建好，每次 runTurn 直接带上。
    this.subagentApprover = deps.subagentApproval === 'strict'
      ? new HeadlessApprover('ask', undefined, deps.permissionRules)
      : undefined;

    // 复制反馈落输入框右上角（状态行右侧），不走全屏 flash；未注入 deps.ui 的测试路径保持默认。
    this.ui =
      deps.ui ??
      new TuiAltScreen(deps.terminal ?? new ProcessTerminal(), false, deps.workspaceRoot, {
        onCopyFeedback: (message) => this.showCopyHint(message),
      });
    this.editor = new CustomEditor(this.ui, getEditorTheme(), {
      paddingX: 1,
      autocompleteMaxVisible: 8,
    });
    this.applyEditorBorder();

    this.documentContainer.addChild(this.headerContainer);
    this.documentContainer.addChild(this.chatContainer);
    this.editorContainer.addChild(this.editor);

    this.footer = new FooterComponent({ get: () => this.footerData() });
    this.footerContainer.addChild(this.footer);

    this.header = new HeaderComponent({ get: () => this.headerData() });
    this.headerContainer.addChild(this.header);

    this.setStatusIndicator(undefined);
  }

  // ------------------------------------------------------------------ 生命周期

  async run(): Promise<void> {
    this.gitBranch = readGitBranch(this.deps.workspaceRoot);
    this.setupLayout();
    this.setupInput();
    this.restoreSession();
    this.refreshCounters();
    for (const warning of this.deps.mcpWarnings ?? []) this.addNotice(warning, 'warn');

    // 信任页已经 start 过同一块替代屏幕时，这里只换 layout，不再进第二次屏。
    if (!this.deps.ui) this.ui.start();
    this.ui.setFocus(this.editor);
    this.ui.requestRender();
    this.startRecapWatch();

    await new Promise<void>((resolve) => {
      this.quitResolve = resolve;
    });
  }

  private setupLayout(): void {
    const transcript = new ScrollView(this.documentContainer, {
      follow: 'end',
      primary: true,
      overscroll: 'chain',
      scrollbar: 'auto',
      scrollbarTrackStyle: (text) => theme.fg('scrollbarThumb', text),
      scrollbarThumbStyle: (text) => theme.fg('scrollbarThumb', text),
      scrollbarUntil: this.editorContainer,
    });
    this.transcriptView = transcript;
    const dock = new VStack([
      { component: this.pendingContainer, shrink: 1, minSize: 0 },
      { component: this.subagentContainer, shrink: 1, minSize: 0 },
      { component: this.statusContainer, shrink: 1, minSize: 0 },
      { component: this.steersContainer, shrink: 1, minSize: 0 },
      { component: this.editorContainer, shrink: 1, minSize: 3 },
      { component: this.footerContainer, shrink: 1, minSize: 1 },
    ]);
    const root = new VStack(
      [
        { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
        { component: dock, basis: 'auto', grow: 0, shrink: 1, minSize: 1 },
      ],
      { gap: 1 },
    );

    // 主屏模式（非 viewport）按顺序铺成一份纵向文档；替代屏幕模式由 layoutRoot 约束。
    this.ui.addChild(this.documentContainer);
    this.ui.addChild(this.pendingContainer);
    this.ui.addChild(this.subagentContainer);
    this.ui.addChild(this.statusContainer);
    this.ui.addChild(this.steersContainer);
    this.ui.addChild(this.editorContainer);
    this.ui.addChild(this.footerContainer);
    if (isViewportTUI(this.ui)) this.ui.setLayoutRoot(root);
  }

  private setupInput(): void {
    const slashCommands: SlashCommand[] = COMMANDS.map((command) => ({
      name: command.id,
      description: command.hint,
    }));
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(slashCommands, this.deps.workspaceRoot));
    this.editor.onSubmit = (text) => {
      void this.handleSubmit(text);
    };
    // 挂起队列非空时 ↑ 把队列全部搬回编辑器（pi 的 dequeue 语义）：删掉不要的行即取消，
    // Enter 重新挂起。全量搬回而不是逐条——一条规则讲清楚，没有歧义中间态。
    // grok-build 语义：有队列时 ↑ 进入队列焦点态（选中最后一行），不再整队搬回——
    // 编辑能力由焦点态里 Enter/e 逐条编辑（原位保存）承担。
    this.editor.onQueueEditUp = () => {
      const items = this.turnInbox.peek();
      if (items.length === 0) return false;
      this.steerFocus = true;
      this.steerCursor = items.length - 1;
      this.steerHover = undefined;
      this.ui.requestRender();
      return true;
    };
    // 队列焦点态的前置拦截：按键归队列面板，未匹配的落回编辑器（打字等）。
    this.editor.onQueueNav = (data) => this.handleQueueNavKey(data);
    // 悬停离开检测：任何鼠标移动先清各类悬停高亮（挂起条浅底/提示/按钮、工具行/汇总行浅底）；
    // 若光标仍悬在原目标上，同帧的组件分发会重新点亮——监听器先于分发执行，一清一亮。
    this.ui.onMouseMotion = () => {
      let changed = clearHoverHighlight();
      if (this.steerHover !== undefined) {
        this.steerHover = undefined;
        changed = true;
      }
      if (this.steerButtonHover !== undefined) {
        this.steerButtonHover = undefined;
        changed = true;
      }
      if (changed) this.ui.requestRender();
    };
    this.editor.onAction('app.followUp', () => {
      const text = this.editor.getText().trim();
      if (text === '' || text.startsWith('/')) return;
      this.editor.setText('');
      this.queueFollowUp(text);
    });
    // 点转录区会把焦点从输入框拿走；任意按键再抢回来，Esc / 输入仍可用。
    this.ui.addInputListener((data) => {
      if (this.ui.getFocusedComponent()) return undefined;
      if (isKeyRelease(data)) return undefined;
      this.ui.setFocus(this.editor);
      return undefined;
    });
    this.editor.onCtrlD = () => this.quit();
    this.editor.onEscape = () => this.handleInterrupt();
    this.editor.onAction('app.tools.expand', () => this.toggleToolExpansion());
    this.editor.onAction('app.command', () => {
      void this.openCommandPalette();
    });

    // 后台任务完成推送（grok 语义：完成唤醒父级）：空闲时自动开一轮消化结果；
    // 轮次进行中由 loop 在下一步顶部注入，这里不抢——回调里只跳过，不做 drain。
    this.deps.jobs.onTaskDone(() => {
      if (this.running) return;
      this.wakeForCompletedJobs();
    });

    this.ui.addInputListener((data) => {
      // Kitty 键盘协议（flags 含 report event types）下一次按键产生 press+release 两个
      // 事件，release 同样被 matchesKey 匹配为原键；不过滤会让 Ctrl+C 双击退出退化成
      // 一次按键就退出。焦点组件路径已由框架过滤，这里补齐 UI 层监听器。
      if (isKeyRelease(data)) return undefined;
      if (this.ui.hasOverlay()) {
        // 浮层打开时只保留「取消」语义，其余按键交给浮层。
        if (matchesAppKey(data, 'app.clear')) {
          this.ui.hideOverlay();
          return { consume: true };
        }
        return undefined;
      }
      if (matchesAppKey(data, 'app.tools.expand')) {
        this.toggleToolExpansion();
        return { consume: true };
      }
      if (matchesAppKey(data, 'app.clear')) {
        this.handleCtrlC();
        return { consume: true };
      }
      return undefined;
    });
  }

  // ------------------------------------------------------------------ 会话回放

  private restoreSession(): void {
    let records = this.session.readAll();
    if (records.length === 0) return;
    const messages = messagesOf(records);
    if (closeInterruptedTurn(this.session, messages) > 0) records = this.session.readAll();

    const view = this.session.readPath();
    this.replayRecords(view.length > 0 ? view : records);
    this.applyEditorBorder();
    this.pinLatestUserMessage();
    const messageCount = messagesOf(records).length;
    if (messageCount > 0) {
      this.addNotice(`Resumed session ${this.session.id} · ${messageCount} messages`, 'dim');
    }
  }

  /** 把最新一条用户消息钉在转录顶：回复还没超出一屏时滚到该条，超出后跟底并由 overlay 吸顶。 */
  private pinLatestUserMessage(): void {
    const view = this.transcriptView;
    if (!view) return;
    const width = Math.max(1, this.ui.terminal.columns);
    let y = this.headerContainer.render(width).length;
    let pin: number | undefined;
    for (const child of this.chatContainer.children) {
      if (child instanceof UserMessageComponent) pin = userMessageBubbleY(y);
      y += child.render(width).length;
    }
    view.setPinY(pin);
  }

  private replayRecords(records: readonly SessionRecord[]): void {
    const folded = foldSessionState(records);
    this.goal = folded.goal;
    this.lastFailure = folded.failures.at(-1);
    this.plan.active = folded.planMode;
    this.lastRecapMainTurn = folded.lastRecapMainTurn;
    // 持久化深度下限：resume 出的子代理会话不能伪装成顶层继续派生（ds 的 delegationDepth 语义）。
    this.sessionDepth = folded.depth;

    for (const record of records) {
      if (record.type === 'message') {
        this.replayMessage(record);
        continue;
      }
      this.replayEvent(record.kind, record.data);
    }
  }

  private replayMessage(record: SessionMessage): void {
    if (record.role === 'user') {
      // 跨轮次状态快照（goal/失败/计划模式）是给模型读的缓存友好注入，不进聊天流——
      // 每轮一条的重复快照在回放里只会是噪声；最新一条的语义已由当前 turn 的注入保证。
      if (isSessionStateMessage(record.content)) return;
      this.chatContainer.addChild(new UserMessageComponent(record.content, getMarkdownTheme()));
      return;
    }
    if (record.role === 'assistant') {
      // 空文本的纯工具回复不建组件、也不打断分组：与实时路径一致——只有真正的
      // 回答文本才把工具 run 切开，多个纯工具回复的工具仍并进同一组。
      if (record.content !== '') {
        this.breakToolGroup();
        const component = new AssistantMessageComponent({ markdownTheme: getMarkdownTheme() });
        component.setText(record.content);
        this.chatContainer.addChild(component);
      }
      for (const call of record.toolCalls ?? []) {
        const tool = new ToolExecutionComponent(call.name, call.id, call.arguments, this.ui);
        tool.markExecutionStarted();
        this.ensureToolGroup().addTool(tool);
        this.pendingTools.set(call.id, tool);
      }
      return;
    }
    if (record.role === 'tool') {
      const tool = record.toolCallId ? this.pendingTools.get(record.toolCallId) : undefined;
      if (tool) {
        tool.updateResult({ content: record.content, isError: false });
        if (record.toolCallId) this.pendingTools.delete(record.toolCallId);
        return;
      }
      const standalone = new ToolExecutionComponent(record.toolName ?? 'tool', record.toolCallId ?? '', {}, this.ui);
      standalone.updateResult({ content: record.content, isError: false });
      this.ensureToolGroup().addTool(standalone);
    }
  }

  private replayEvent(kind: string, data: Record<string, unknown>): void {
    if (kind === 'model_selection' && typeof data.model === 'string') {
      this.model = data.model;
      if (typeof data.contextWindow === 'number') this.contextWindow = data.contextWindow;
      if (typeof data.maxTokens === 'number') this.maxTokens = data.maxTokens;
      return;
    }
    if (kind === 'usage') {
      this.applyUsage(data);
      return;
    }
    if (kind === 'recap') {
      // 未上屏的 recap（自动长尾输出）只留档，回放时跳过——否则用户会在恢复后
      // 看到一条当时被刻意压下去的跑飞摘要。
      if (data.shown === false) return;
      const summary = typeof data.summary === 'string' ? data.summary : '';
      if (summary !== '') this.addRecap(summary);
      return;
    }
    if (kind === 'subagent' && data.phase === 'start') {
      // 回放与实时路径同构：按 toolCallId 归位到 Task 工具行，聚合活动无法恢复
      // （子工具调用不落主会话），只恢复行首文案与 (type, background) 元信息；不建实时行。
      const id = typeof data.id === 'string' ? data.id : '';
      const description = typeof data.description === 'string' ? data.description : '';
      const toolCallId = typeof data.toolCallId === 'string' ? data.toolCallId : undefined;
      const tool = toolCallId !== undefined ? this.pendingTools.get(toolCallId) : undefined;
      if (id !== '' && tool) {
        const background = data.mode === 'background';
        tool.attachSubagentMeta({
          index: ++this.subagentOrdinal,
          childType: typeof data.childType === 'string' ? data.childType : undefined,
          background,
          description,
        });
        this.subagentLines.set(id, { tool, description, toolCallId, background });
      } else {
        this.addNotice(`subagent · ${description}`, 'dim');
      }
      return;
    }
    if (kind === 'subagent' && data.phase === 'end') {
      const ok = data.ok === true;
      const durationMs = typeof data.durationMs === 'number' && Number.isFinite(data.durationMs) ? data.durationMs : 0;
      const summary = typeof data.summary === 'string' ? data.summary : '';
      const tokens = typeof data.tokens === 'number' && Number.isFinite(data.tokens) ? data.tokens : undefined;
      if (!this.finishSubagentLine(typeof data.id === 'string' ? data.id : '', ok, durationMs, summary, tokens)) {
        this.addNotice(`subagent · ${ok ? 'done' : 'FAILED'}`, ok ? 'dim' : 'error');
      }
    }
  }

  // ------------------------------------------------------------------ 提交与轮次

  private async handleSubmit(rawText: string): Promise<void> {
    const text = rawText.trim();
    // 空草稿 + 运行中队列非空：Enter 的意思是「现在就发」——中断当前轮，把挂起队列合并
    // 成一次投递立即开新一轮（对齐 claude code 的 Enter to send them immediately）。
    // 必须在空文本早退之前判定，编辑器对空草稿同样会触发 onSubmit，否则此路永远不通。
    if (text === '') {
      if (this.running && this.turnInbox.peek().length > 0) this.sendQueuedNow();
      return;
    }
    this.editor.setText('');
    this.history.push(text);

    if (text.startsWith('/')) {
      await this.handleCommand(text);
      return;
    }
    if (this.running) {
      // 队列满时拒绝而不是挤掉最旧：静默丢用户的输入是最差的失败模式。
      if (this.turnInbox.full()) {
        this.addNotice(
          `Steering queue is full (${STEERING_QUEUE_LIMIT}) — press Enter to send now, or ↑ to edit the queue.`,
          'warn',
        );
        return;
      }
      if (this.steerEditIndex !== undefined) {
        // 双击取回后重新挂起：插回原排序位而不是队尾（队列已被 drain 时越界收敛为追加）。
        // 提交即解冻：编辑期间轮次若已收尾，这里补开新轮，让编辑后的消息第一个发出。
        this.turnInbox.insertAt(this.steerEditIndex, text);
        this.steerCursor = Math.min(this.steerEditIndex, this.turnInbox.peek().length - 1);
        this.steerEditIndex = undefined;
        this.ui.requestRender();
        if (!this.running) {
          const head = this.turnInbox.peek()[0];
          if (head !== undefined) {
            this.turnInbox.removeAt(0);
            this.resetSteerState();
            void this.executeTurn(head, true);
          }
        }
        return;
      } else {
        this.turnInbox.push(text);
        this.steerCursor = this.turnInbox.peek().length - 1;
      }
      // 挂起条随下一帧自动更新（steersBar 每帧动态渲染），不再弹 dim 通知。
      this.ui.requestRender();
      return;
    }
    await this.executeTurn(text, true);
  }

  private queueFollowUp(text: string): void {
    // 与 steering 挂起队列同一上限：两处都是「补充方向」，堆积同样稀释模型注意力。
    if (this.followUps.length >= STEERING_QUEUE_LIMIT) {
      this.addNotice(`Follow-up queue is full (${STEERING_QUEUE_LIMIT}) — cancel one first.`, 'warn');
      return;
    }
    this.followUps.push(text);
    this.addNotice(`Queued follow-up (${this.followUps.length}) — runs after this turn.`, 'dim');
    this.ui.requestRender();
  }

  private async executeTurn(prompt: string, rewindable = false): Promise<void> {
    this.chatContainer.addChild(new UserMessageComponent(prompt, getMarkdownTheme()));
    this.pinLatestUserMessage();
    this.ui.requestRender();

    // 新轮次开始：正在生成的 recap 即使回来了也不再上屏（迟到的摘要会插在新一轮中间）。
    this.recapEpoch++;

    const controller = new AbortController();
    this.abort = controller;
    this.running = true;
    this.modelResponded = false;
    this.inFlightPrompt = rewindable ? prompt : undefined;
    this.pendingRewind = undefined;
    // 发出去之后输入框失焦：否则边框一直是聚焦色，像还在打字。
    this.ui.setFocus(null);
    const indicator = new WorkingStatusIndicator(this.ui, WorkingLabel.working);
    if (this.contextTokens !== undefined) indicator.setTokens(this.contextTokens);
    this.setStatusIndicator(indicator);
    // 指示器已带初始文案，这里只是把 activityLabel 记上，后续 setActivity 才知道该不该重设。
    this.setActivity(WorkingLabel.working);

    try {
      await (this.deps.driver ?? runTurn)({
        prompt,
        workspaceRoot: this.deps.workspaceRoot,
        client: this.client,
        model: this.model,
        session: this.session,
        tools: this.deps.tools ?? defaultTools,
        sessions: this.deps.sessions ?? jsonlSessionFactory,
        sandbox: this.deps.sandbox,
        approver: this.approver,
        contextWindow: this.contextWindow,
        depth: this.sessionDepth,
        maxSubagentDepth: this.deps.maxSubagentDepth,
        maxSessionTokens: this.deps.maxSessionTokens,
        listener: this.listener,
        signal: controller.signal,
        mcp: this.deps.mcp,
        todos: this.deps.todos,
        jobs: this.deps.jobs,
        memory: new TouchMemory(this.deps.workspaceRoot),
        worktrees: this.deps.worktrees,
        goal: this.goal,
        lastFailure: this.lastFailure,
        planMode: this.plan,
        reviewPlan: (plan, title) => this.reviewPlan(plan, title),
        compactClient: this.compactClient,
        onAuxUsage: (usage, purpose) => this.recordAuxUsage(usage, purpose),
        ...(this.deps.spillRoot === undefined
          ? {}
          : { spill: new SpillStore(join(this.deps.spillRoot, this.session.id), this.deps.spillThreshold) }),
        ...(this.subagentApprover === undefined ? {} : { subagentApprover: this.subagentApprover }),
      });
    } catch (error) {
      // 中断提示已由 handleInterrupt 即时给出，这里不再重复一条。
      if (!controller.signal.aborted) this.addNotice(message(error), 'error');
    } finally {
      this.finalizeStreaming();
      this.running = false;
      this.abort = undefined;
      const rewind = this.pendingRewind;
      this.pendingRewind = undefined;
      this.inFlightPrompt = undefined;
      if (rewind !== undefined) {
        this.dropLastUserBubble();
        // Esc 中断自带队列回填（对齐 pi：abort restores queued messages）——模型还没
        // 响应时整个轮次作废重来，未投递的挂起消息连同原 prompt 一起回到编辑器。
        // 模型已响应的普通中断不在此列：队列继续挂起，下一轮照常自动投递。
        const stranded = this.turnInbox.drain();
        this.resetSteerState();
        const restored = stranded.length > 0
          ? `${rewind}\n\n${stranded.join('\n\n')}`
          : rewind;
        this.editor.setText(restored);
        this.pinLatestUserMessage();
      }
      // 轮次正常收尾后挂起队列若还有存货——运行中入队的消息不打断当前任务、一律等
      // 到现在——第一条自动开新轮消化（对齐 claude code：队列在轮次结束后按序接管）。
      // 其余留在条上，由后续轮次收尾继续逐条消化。挂起消息
      // 优先于 followUps：前者是用户当场打的字。双击编辑冻结中与后台任务唤醒刚开过
      // 新轮时都让路：前者等编辑提交，后者避免并发双轮。
      const normalEnd = !controller.signal.aborted && rewind === undefined;
      const steerNext = normalEnd && this.steerEditIndex === undefined ? this.turnInbox.peek()[0] : undefined;
      const follow = normalEnd && steerNext === undefined ? this.followUps.shift() : undefined;
      // 空闲计时从轮次收尾算起：一轮跑两分钟不该把那两分钟算成「用户离开」。
      this.lastActivityAt = Date.now();
      this.setStatusIndicator(undefined);
      this.pendingTools.clear();
      // 轮次结束但后台子代理仍在跑（foreground 的 end 事件在工具返回前就已到）：
      // 提醒一句，避免用户以为总结就是全部结论。
      if (this.subagentLines.size > 0) {
        const n = this.subagentLines.size;
        this.addNotice(`${n} background subagent${n === 1 ? ' still running' : 's still running'} — /jobs to inspect.`, 'dim');
      }
      // 不在这里 refreshCounters()：用量已由 'usage' 事件在内存里累加，重读整个会话文件
      // 只是把同一份数据再算一遍（长会话可达数 MB）。只有切换/新建会话时才需要重算。
      this.ui.setFocus(this.editor);
      this.ui.requestRender();
      // 竞态收口：通知在轮次收尾瞬间到达时，onTaskDone 回调已被 running 挡掉，
      // 这里补一次 drain——否则结果要滞留到用户下一次发言才被注入。
      this.wakeForCompletedJobs();
      // 立即发送：挂起队列触发的「现在就发」——中断后以合并文本接续，优先于
      // followUps（followUps 属于被中断的那一轮，留给新轮结束后再消费）。
      if (this.sendAfterInterrupt !== undefined) {
        const prompt = this.sendAfterInterrupt;
        this.sendAfterInterrupt = undefined;
        void this.executeTurn(prompt, true);
        return;
      }
      if (!this.running && steerNext !== undefined) {
        this.turnInbox.removeAt(0);
        this.resetSteerState();
        void this.executeTurn(steerNext, true);
        return;
      }
      if (!this.running && follow) void this.executeTurn(follow, true);
    }
  }

  /**
   * 后台任务完成唤醒（grok 语义：完成唤醒父级）。空闲时自动开一轮，把完成通知
   * 作为 user 消息注入；通知正文由 jobNotificationText 统一构造，与 loop 注入同款。
   */
  private wakeForCompletedJobs(): void {
    const notifications = this.deps.jobs.drainNotifications();
    if (notifications.length === 0) return;
    const prompt = notifications.map(jobNotificationText).join('\n\n');
    this.addNotice('Background task completed — continuing.', 'dim');
    void this.executeTurn(prompt);
  }

  /**
   * 「现在就发」：把挂起队列合并成一次投递，中断当前轮并立即开新一轮。
   *
   * 为什么是中断而不是插话：模型正在生成的半截响应与挂起消息并存时，先后语义会乱——
   * 用户按 Enter 的意图就是「别管当前的了，先看我的」。中断走正常 abort 路径（工具
   * 清理与 interrupted 事件都是既有语义）；不设置 pendingRewind——原轮的 prompt 与
   * 部分输出保留在对话里（它们是发生过的事实），新轮从合并文本接续。
   */
  private sendQueuedNow(): void {
    if (!this.abort) return;
    // 双击编辑冻结中：立即发送会把其余挂起消息越过正在编辑的那条送出去，不做。
    if (this.steerEditIndex !== undefined) return;
    const queued = this.turnInbox.drain();
    if (queued.length === 0) return;
    this.resetSteerState();
    this.sendAfterInterrupt = queued.join('\n\n');
    this.setActivity(WorkingLabel.cancelling);
    this.abort.abort();
  }

  /**
   * Esc / Ctrl+C：终止当前轮次。
   *
   * 对齐 grok cancel-rewind：模型还没有任何响应时把原文放回输入框，转录里那条气泡也撤掉
   * （看起来像没按过发送）。已经开始思考/正文/工具则只打断，不回填。
   * 输入框里已有新草稿时不覆盖（grok 同样不 clobber composer）。
   */
  private handleInterrupt(): void {
    if (this.abort) {
      this.setActivity(WorkingLabel.cancelling);
      const composerEmpty = this.editor.getText().trim() === '';
      const rewind = !this.modelResponded && this.inFlightPrompt !== undefined && composerEmpty;
      this.pendingRewind = rewind ? this.inFlightPrompt : undefined;
      this.abort.abort();
      this.addNotice(
        rewind
          ? 'Cancelled — prompt restored to the input.'
          : this.modelResponded
            ? 'Interrupted — output stopped.'
            : 'Cancelled before the model replied.',
        'warn',
      );
      return;
    }
    if (this.ui.hasOverlay()) {
      this.ui.hideOverlay();
    }
  }

  /** 取消未响应的一轮：撤掉刚贴上的用户气泡，界面回到发送前。 */
  private dropLastUserBubble(): void {
    const children = this.chatContainer.children;
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (child instanceof UserMessageComponent) {
        this.chatContainer.removeChild(child);
        return;
      }
    }
  }

  // ------------------------------------------------------------------ 事件投影

  /**
   * transcript：转录区内容变了，必须 bump contentGeneration，否则 ScrollView 缓存不重测。
   * dock：底栏/子代理行，走视口通道，避免把整份转录当结构变化重排。
   */
  private paint(kind: 'transcript' | 'dock'): void {
    if (kind === 'dock' && isViewportTUI(this.ui)) this.ui.requestViewportRender();
    else this.ui.requestRender();
  }

  private readonly listener: AgentListener = (event) => {
    switch (event.type) {
      case 'stream_retry': {
        this.thinkingGroup?.dropStreamingThinking();
        this.thinkingBuffer = '';
        this.thinkingStartedAt = Date.now();
        this.thinkingGroup?.beginThinking();
        if (this.streamingAssistant) {
          this.chatContainer.removeChild(this.streamingAssistant);
          this.streamingAssistant = undefined;
        }
        this.paint('transcript');
        return;
      }
      case 'text': {
        this.modelResponded = true;
        this.setActivity(WorkingLabel.responding);
        const assistant = this.ensureAssistant();
        assistant.appendText(event.text);
        this.paint('transcript');
        return;
      }
      case 'thinking_start': {
        this.thinkingId = event.id;
        this.thinkingBuffer = '';
        this.thinkingStartedAt = Date.now();
        // 不在 start 切 Thinking…：无 reasoning 的工具轮次永远等不到 delta，状态行会假死。
        // 压缩刚结束时要把 Folding context… 收回去，否则会一直挂到第一条 delta。
        if (this.activityLabel === WorkingLabel.compacting) this.setActivity(WorkingLabel.working);
        this.thinkingGroup = this.ensureToolGroup();
        this.thinkingGroup.beginThinking();
        this.paint('transcript');
        return;
      }
      case 'thinking_delta': {
        if (event.id === this.thinkingId) {
          this.modelResponded = true;
          this.setActivity(WorkingLabel.thinking);
          this.thinkingBuffer += event.text;
          this.thinkingGroup?.setThinking(this.thinkingBuffer, true);
        }
        this.paint('transcript');
        return;
      }
      case 'thinking_end': {
        if (event.id === this.thinkingId) {
          // 正文先于 thinking_end 到达，所以这里必须认住开始时那个组，而不是重新 ensureToolGroup——
          // 中途的 text 已经断开旧组，重新取会新开一个组，把同一段推理劈成两半。
          // content 是权威全文；只有它为空的异常路径（思考中途报错，loop 补发 content: ''）
          // 才回落到已经流出的增量，别把用户已经看到的推理丢掉。
          const content = event.content !== '' ? event.content : this.thinkingBuffer;
          this.thinkingGroup?.setThinking(content, false, this.thinkingElapsed());
          this.thinkingGroup = undefined;
          this.thinkingStartedAt = undefined;
          this.thinkingBuffer = '';
          this.thinkingId = undefined;
          // 没 reasoning 的工具轮次不会再来 thinking_delta；状态行若还停在 Thinking…，
          // 这里立刻离开，别等下一步工具/正文。
          if (this.activityLabel === WorkingLabel.thinking) this.setActivity(WorkingLabel.working);
        }
        this.paint('transcript');
        return;
      }
      case 'tool_start': {
        this.modelResponded = true;
        // 工具活动切断当前助手段：下一个 thinking/text 事件经 ensureAssistant 在工具组
        // 下方新起组件。否则整轮文字都挤进轮首那个组件里，最终总结会排在工具汇总之上，
        // 变成「全部回答在上、工具组沉底」——时间线要按真实顺序交错（grok-build 语义）。
        this.streamingAssistant?.setStreaming(false);
        this.streamingAssistant = undefined;
        const tool = new ToolExecutionComponent(event.name, event.id, event.args, this.ui);
        tool.markExecutionStarted();
        this.ensureToolGroup().addTool(tool);
        this.pendingTools.set(event.id, tool);
        this.setActivity(WorkingLabel.running(toolDisplayName(event.name), summarizeArgs(event.name, event.args)));
        // subagent 的实时进度由转录内任务块承担，不进底部「正在跑」区。
        if (event.name !== 'subagent') this.addPendingToolLine(event.id, event.name, event.args);
        this.paint('transcript');
        return;
      }
      case 'tool_end': {
        const tool = this.pendingTools.get(event.id);
        if (tool) {
          tool.updateResult({ content: event.content, isError: !event.ok });
          this.pendingTools.delete(event.id);
        }
        this.removePendingToolLine(event.id);
        // 工具收尾后回到「等模型下一步」：可能是压缩，也可能是下一次请求。
        this.setActivity(WorkingLabel.working);
        this.paint('transcript');
        return;
      }
      case 'usage': {
        this.applyUsage(event as unknown as Record<string, unknown>);
        this.paint('dock');
        return;
      }
      case 'status': {
        // 压缩开始由 loop 发同一句 WorkingLabel.compacting，只改状态行，不进转录。
        if (event.text === WorkingLabel.compacting) {
          this.setActivity(WorkingLabel.compacting);
          this.paint('dock');
          return;
        }
        if (event.text.startsWith('context compacted') && this.activityLabel === WorkingLabel.compacting) {
          this.setActivity(WorkingLabel.working);
        }
        // 轮次中的 warn 叠在工作状态行上（带次数），不进转录——否则 Thinking… 会被一条
        // notice 打断，重试/截断流看起来像聊天记录。
        if (event.level === 'warn' && this.showWorkingWarning(event.text)) {
          this.paint('dock');
          return;
        }
        // 模型经 enter_plan_mode 改的是 this.plan.active，边框要立刻跟上。
        if (event.text.startsWith('Plan mode ')) this.applyEditorBorder();
        this.addNotice(event.text, event.level ?? 'dim');
        this.paint('transcript');
        return;
      }
      case 'error': {
        this.addNotice(event.text, 'error');
        this.paint('transcript');
        return;
      }
      case 'subagent_start': {
        this.subagentDepth++;
        // 活动归并到主流程的 Task 工具行上（grok-build 式的单行实时摘要），
        // 不再发独立通知——通知会打断工具分组，把每个 task 挤成孤立的「1 Tool」组。
        const tool = event.toolCallId ? this.pendingTools.get(event.toolCallId) : undefined;
        if (tool) {
          const background = event.mode === 'background';
          const index = ++this.subagentOrdinal;
          tool.attachSubagentMeta({ index, childType: event.childType, background, description: event.description });
          // 实时进度挂到输入框上方那一栏（跑完即撤，不常驻）；转录里留下的是同一行首文案的
          // 完成摘要，dock 带类型，转录行只要序号+描述+耗时。
          const live = new SubagentTaskComponent(this.ui, {
            index,
            childType: event.childType,
            background,
            description: event.description,
          });
          this.subagentLines.set(event.id, {
            tool,
            description: event.description,
            toolCallId: event.toolCallId,
            background,
            live,
          });
          this.refreshSubagentDock();
        } else {
          this.addNotice(
            `subagent · ${event.description} (${event.childType}${event.mode === 'background' ? ', background' : ''})`,
            'dim',
          );
        }
        this.paint('transcript');
        return;
      }
      case 'subagent_end': {
        this.subagentDepth = Math.max(0, this.subagentDepth - 1);
        if (!this.finishSubagentLine(event.id, event.ok, event.durationMs, event.summary, event.tokens)) {
          const label = event.ok
            ? `subagent · done in ${(event.durationMs / 1000).toFixed(1)}s`
            : `subagent · FAILED: ${event.summary.slice(0, 200)}`;
          this.addNotice(label, event.ok ? 'dim' : 'error');
        }
        this.paint('transcript');
        return;
      }
      case 'subagent_event': {
        this.onSubagentEvent(event.id, event.event);
        return;
      }
      case 'done': {
        this.finalizeStreaming();
        this.paint('transcript');
        return;
      }
      default:
        break;
    }
  };

  /**
   * 子代理内部活动 → 输入框上方那一行的活动段。
   *
   * 同时按显示名累加工具调用计数——计数不当场显示（活动段此时是当前动作），它在收尾时
   * 顶替活动段，成为那行的持久内容。
   */
  private onSubagentEvent(id: string, event: SubagentEvent): void {
    const entry = this.subagentLines.get(id);
    if (!entry) {
      // 行没建出来（异常时序/老会话回放）：退回独立行，至少不让子活动凭空消失。
      if (event.type === 'tool_start') this.addNotice(`  ↳ ${event.name}`, 'dim');
      else if (event.type === 'error') this.addNotice(`  ↳ ${event.text}`, 'error');
      if (event.type === 'tool_start' || event.type === 'error') this.paint('transcript');
      return;
    }
    if (event.type === 'usage') {
      entry.live?.addTokens(event.promptTokens + event.completionTokens);
      this.paint('dock');
      return;
    }
    const activity = subagentActivity(event);
    if (activity !== undefined) entry.live?.setActivity(activity, event.type === 'error');
    this.paint('dock');
  }

  /**
   * 刷新输入框上方的子代理栏：段头 + 每个运行中的子代理一行。
   *
   * 位置在工作状态提示之上（参考实现 dock 的位置）：转录只留完成摘要，实时进度全在这里，
   * 跑完即撤。行数超上限就截断，免得 dock 把转录区挤没。
   */
  private refreshSubagentDock(): void {
    this.subagentContainer.clear();
    const rows = [...this.subagentLines.values()]
      .map((entry) => entry.live)
      .filter((live) => live !== undefined);
    if (rows.length === 0) return;

    const shown = rows.slice(0, MAX_DOCK_SUBAGENT_ROWS);
    this.subagentHeader.setText(`${' '.repeat(TOOL_GROUP_INDENT)}${theme.fg('dim', `Subagents ${rows.length}`)}`);
    this.subagentContainer.addChild(this.subagentHeader);
    for (const row of shown) this.subagentContainer.addChild(row);
    if (rows.length > shown.length) {
      this.subagentContainer.addChild(
        new Text(`${' '.repeat(TOOL_MEMBER_INDENT)}${theme.fg('dim', `… ${rows.length - shown.length} more`)}`, 0, 0),
      );
    }
  }

  /**
   * 收尾一个子代理：转录行只留 `Subagent N 描述 · 总耗时`，实时 dock 行撤掉。
   */
  private finishSubagentLine(id: string, ok: boolean, durationMs: number, summary: string, _tokens?: number): boolean {
    const entry = this.subagentLines.get(id);
    if (!entry) return false;
    entry.live?.dispose();
    // 报告写进工具详情：否则双击展开没有正文（尤其后台任务 tool_end 只是 job 回执）。
    const report = summary.trim();
    if (report !== '') entry.tool.updateResult({ content: report, isError: !ok });
    if (ok) entry.tool.setActivity(formatDuration(durationMs));
    else entry.tool.setActivity(`FAILED: ${flattenWhitespace(summary).slice(0, 100)}`, true);
    this.subagentLines.delete(id);
    this.refreshSubagentDock();
    return true;
  }

  private thinkingBuffer = '';
  private readonly pendingToolLines = new Map<string, Text>();

  private ensureAssistant(): AssistantMessageComponent {
    if (!this.streamingAssistant) {
      this.breakToolGroup();
      const assistant = new AssistantMessageComponent({ markdownTheme: getMarkdownTheme() });
      assistant.setStreaming(true);
      this.chatContainer.addChild(assistant);
      this.streamingAssistant = assistant;
    }
    return this.streamingAssistant;
  }

  /** 取当前工具分组；没有就新建一个挂到对话流末尾。 */
  private ensureToolGroup(): ToolGroupComponent {
    if (!this.activeToolGroup) {
      const group = new ToolGroupComponent(this.ui);
      this.chatContainer.addChild(group);
      this.toolGroups.push(group);
      this.activeToolGroup = group;
    }
    return this.activeToolGroup;
  }

  /** 断开当前分组：下一个工具调用会另起一组，子代理序号也跟着从头数。 */
  private breakToolGroup(): void {
    this.activeToolGroup = undefined;
    this.subagentOrdinal = 0;
  }

  private finalizeStreaming(): void {
    this.breakToolGroup();
    if (this.streamingAssistant) {
      this.streamingAssistant.setStreaming(false);
      this.streamingAssistant = undefined;
    }
    // 轮次可能在思考中途收尾（中断/异常），此时 thinking_end 不会再来：主动把成员从
    // 「运行中」落下，否则转录里会永远留着一行 Thinking…，而且它还会一直占着行不折叠。
    this.thinkingGroup?.setThinking(this.thinkingBuffer, false, this.thinkingElapsed());
    this.thinkingBuffer = '';
    this.thinkingId = undefined;
    this.thinkingStartedAt = undefined;
    this.thinkingGroup = undefined;
    for (const line of this.pendingToolLines.values()) this.pendingContainer.removeChild(line);
    this.pendingToolLines.clear();
  }

  /** 本段思考链已耗时；没记到起点时返回 undefined（收尾文案退化成 `Thought`）。 */
  private thinkingElapsed(): number | undefined {
    return this.thinkingStartedAt === undefined ? undefined : Date.now() - this.thinkingStartedAt;
  }

  /**
   * 挂起条：运行中输入队列的可视化（grok-build queue pane 同款）。
   *
   * 每帧从 turnInbox 动态取数——消息只在轮次收尾后逐条投递，投递一条下一帧自动少一条。
   * 首行上方留一行间距（与状态行脱开）；一格缩进与状态行左缘（leftPad=1）对齐。前缀是
   * 投递顺序序号（`1.` `2.`…，重排后按新位置重新编号）。鼠标悬停的行或队列焦点态的
   * 选中行：整行铺浅底（悬停 steerHoverBg 极浅、焦点选中 selectedBg 更强），右侧亮出
   * 动作按钮 `[Send now] [edit] [cancel]`（右对齐紧贴无缝、右缘与状态行耗时/token 同
   * 列，宽不够整颗放弃），按钮自身悬停变色。
   */
  private renderPendingSteers(width: number): string[] {
    const items = this.turnInbox.peek();
    if (items.length === 0) {
      this.steerButtons = [];
      return [];
    }
    const cursor = Math.min(this.steerCursor ?? items.length - 1, items.length - 1);
    const hover = this.steerHover !== undefined && this.steerHover < items.length ? this.steerHover : undefined;
    // 动作按钮只挂一行：悬停行优先，其次焦点态的选中行（grok 同款——悬停无需先选中即可操作）。
    const actionRow = hover ?? (this.steerFocus ? cursor : undefined);
    const buttons = actionRow === undefined ? [] : this.layoutSteerButtons(width);
    const btnStart = buttons[0]?.x0 ?? width - STEER_RIGHT_PAD;
    this.steerButtons = buttons.map((button, i) => {
      const x0 = btnStart + buttons.slice(0, i).reduce((sum, b) => sum + b.label.length, 0);
      return { row: actionRow!, action: button.action, x0, x1: x0 + button.label.length };
    });
    const lines = items.map((text, index) => {
      const hovered = index === hover;
      const selected = this.steerFocus && index === cursor;
      const num = theme.fg('primary', `${index + 1}.`);
      // 带按钮的行：行文按按钮起点截断让位（至少留 1 列间隙）。
      const avail = index === actionRow ? Math.max(0, btnStart - 4 - 1) : 96;
      const clipped = flattenWhitespace(text).slice(0, avail);
      const styled = index === cursor ? theme.bold(clipped) : theme.fg('muted', clipped);
      let line = ` ${num} ${styled}`;
      if (index === actionRow) {
        const pad = Math.max(1, btnStart - visibleWidth(line));
        line += ' '.repeat(pad);
        for (const button of buttons) line += this.steerButtonLabel(button.action, index);
      }
      // 悬停行铺极浅底；焦点选中行铺更强的选中底（选中优先，grok 同款）。
      const fill = Math.max(0, width - visibleWidth(line));
      if (selected) return theme.bg('selectedBg', line + ' '.repeat(fill));
      if (hovered) return theme.bg('steerHoverBg', line + ' '.repeat(fill));
      return line;
    });
    lines.unshift('');
    return lines;
  }

  /** 布局动作按钮链：从右往左紧贴排布，放不下整颗放弃。空数组 = 宽度不足以放任何按钮。 */
  private layoutSteerButtons(width: number): Array<{ action: SteerAction; label: string; x0: number }> {
    let right = width - STEER_RIGHT_PAD;
    const placed: Array<{ action: SteerAction; label: string; x0: number }> = [];
    for (const { action, label } of STEER_BUTTONS) {
      const x0 = right - label.length;
      if (x0 < 5) break; // 行文至少保留一格缩进 + 序号 + 一格空隙
      placed.unshift({ action, label, x0 });
      right = x0;
    }
    return placed;
  }

  /** 动作按钮文案：默认 muted，悬停变色（cancel 红、edit/send 亮文字）。 */
  private steerButtonLabel(action: SteerAction, row: number): string {
    const label = STEER_BUTTONS.find((button) => button.action === action)!.label;
    const hoveredButton = this.steerButtonHover?.row === row && this.steerButtonHover.action === action;
    if (!hoveredButton) return theme.fg('muted', label);
    return theme.fg(action === 'cancel' ? 'error' : 'text', label);
  }

  /**
   * 挂起条行内鼠标交互（grok-build queue pane 同款）：按钮命中优先
   * （[Send now]/[edit]/[cancel] 直接执行动作）；单击行 = 选中并聚焦队列面板。
   * 双击无特殊语义（grok 的队列行双击是 ListPane 划词，这里没有对应物）。
   * 左键按下先用 handleSelectablePress 钉行吃掉（与工具行同款）：否则全屏划词路径
   * 接手，会把消息文本选中。
   * click 事件必须返回 handled 挡住冒泡，避免同一次点击沿布局链多次送达。
   */
  private onSteersMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const items = this.turnInbox.peek();
    if (event.type === 'move') {
      // 悬停：该行铺浅底并亮出动作按钮，同时成为队列焦点态的选中行。移出的隐藏由
      // onMouseMotion 先清、这里的命中分发再点亮（同帧内一清一亮，不需要绝对坐标）。
      // 首行是上间距空行：y 换算行下标要扣掉。
      const row = event.y - STEER_TOP_GAP;
      if (row >= 0 && row < items.length) {
        const button = this.steerButtons.find((b) => b.row === row && event.x >= b.x0 && event.x < b.x1);
        const nextButton = button ? { row, action: button.action } : undefined;
        if (
          this.steerHover !== row ||
          this.steerCursor !== row ||
          this.steerButtonHover?.row !== nextButton?.row ||
          this.steerButtonHover?.action !== nextButton?.action
        ) {
          this.steerHover = row;
          this.steerCursor = row;
          this.steerButtonHover = nextButton;
          this.ui.requestRender();
        }
      }
      return undefined;
    }
    if (event.type === 'press' && event.button === 'left') {
      const press = handleSelectablePress(this.steersBar, event);
      if (press) return press;
    }
    if (event.type !== 'click' || event.button !== 'left') return undefined;
    const row = event.y - STEER_TOP_GAP;
    if (row < 0 || row >= items.length) return undefined;
    // 按钮命中优先：直接执行动作，不再走行选中。
    const button = this.steerButtons.find((b) => b.row === row && event.x >= b.x0 && event.x < b.x1);
    if (button) {
      if (button.action === 'cancel') this.cancelSteerRow(row);
      else if (button.action === 'edit') this.editSteerRow(row);
      else this.sendSteerRowNow(row);
      return { handled: true };
    }
    // 单击行 = 选中并聚焦队列面板（grok：set_active_pane(Queue)）。
    this.steerCursor = row;
    this.steerFocus = true;
    this.ui.requestRender();
    return { handled: true };
  }

  /** 队列焦点态按键（grok-build queue pane 同款）：未匹配的返回 false 落回编辑器。 */
  private handleQueueNavKey(data: string): boolean {
    if (!this.steerFocus) return false;
    const items = this.turnInbox.peek();
    if (items.length === 0) {
      this.exitSteerFocus();
      return false;
    }
    const cursor = Math.min(this.steerCursor ?? items.length - 1, items.length - 1);
    const repaint = (): void => this.ui.requestRender();
    if (matchesKey(data, 'escape')) {
      this.exitSteerFocus();
      return true;
    }
    if (matchesKey(data, 'up')) {
      // 首行再 ↑ 保持夹住：越界会误开输入历史并改写草稿（grok 同理）。
      this.steerCursor = Math.max(0, cursor - 1);
      repaint();
      return true;
    }
    if (matchesKey(data, 'down')) {
      // ↓ 越过最后一行回编辑器。
      if (cursor >= items.length - 1) {
        this.exitSteerFocus();
        return true;
      }
      this.steerCursor = cursor + 1;
      repaint();
      return true;
    }
    // 面板内 j/k 导航（grok ListPane 同款）：到边界夹住，不触发退出。
    if (data === 'j' && cursor < items.length - 1) {
      this.steerCursor = cursor + 1;
      repaint();
      return true;
    }
    if (data === 'k' && cursor > 0) {
      this.steerCursor = cursor - 1;
      repaint();
      return true;
    }
    // ⇧J 下移 / ⇧K 上移（重排的是选中条，序号随新位置重编）。
    if (data === 'J' && cursor < items.length - 1) {
      this.turnInbox.move(cursor, 1);
      this.steerCursor = cursor + 1;
      repaint();
      return true;
    }
    if (data === 'K' && cursor > 0) {
      this.turnInbox.move(cursor, -1);
      this.steerCursor = cursor - 1;
      repaint();
      return true;
    }
    if (data === '\r' || data === 'e') {
      this.editSteerRow(cursor);
      return true;
    }
    if (data === 'x' || matchesKey(data, 'delete') || matchesKey(data, 'backspace')) {
      this.cancelSteerRow(cursor);
      return true;
    }
    return false;
  }

  /** 取回选中条到输入框编辑：队列里删掉、记住原位置并冻结投递（提交后原位回插）。 */
  private editSteerRow(index: number): void {
    const text = this.turnInbox.removeAt(index);
    if (text === undefined) return;
    this.exitSteerFocus();
    this.steerEditIndex = index;
    const current = this.editor.getText().trim();
    this.editor.setText(current === '' ? text : `${current}\n\n${text}`);
    this.steerCursor = Math.min(index, this.turnInbox.peek().length - 1);
    this.ui.setFocus(this.editor);
    this.ui.requestRender();
  }

  /** 删除选中条（不回填编辑器）：队列空则顺手退出焦点态。 */
  private cancelSteerRow(index: number): void {
    if (this.turnInbox.removeAt(index) === undefined) return;
    if (this.turnInbox.peek().length === 0) this.exitSteerFocus();
    this.steerCursor = Math.min(index, this.turnInbox.peek().length - 1);
    this.ui.requestRender();
  }

  /** 强制立即发送选中条：中断当前轮，该条作为下一轮 prompt，其余消息保持原队列。 */
  private sendSteerRowNow(index: number): void {
    const text = this.turnInbox.removeAt(index);
    if (text === undefined || !this.abort) return;
    this.exitSteerFocus();
    this.sendAfterInterrupt = text;
    this.setActivity(WorkingLabel.cancelling);
    this.abort.abort();
  }

  private exitSteerFocus(): void {
    if (!this.steerFocus) return;
    this.steerFocus = false;
    this.ui.requestRender();
  }

  /** 队列被整队搬走（立即发送 / 轮次作废）后，选中、编辑占位与焦点态一并失效。 */
  private resetSteerState(): void {
    this.steerCursor = undefined;
    this.steerEditIndex = undefined;
    this.steerHover = undefined;
    this.steerFocus = false;
    this.steerButtonHover = undefined;
  }

  private addPendingToolLine(id: string, name: string, args: Record<string, unknown>): void {
    const detail = typeof args.command === 'string' ? args.command : (typeof args.path === 'string' ? args.path : '');
    const oneLine = flattenWhitespace(`${name}${detail ? ` ${detail}` : ''}`).slice(0, 100);
    const text = new Text(theme.fg('muted', `  ${oneLine}`), 0, 0);
    this.pendingContainer.addChild(text);
    this.pendingToolLines.set(id, text);
  }

  private removePendingToolLine(id: string): void {
    const line = this.pendingToolLines.get(id);
    if (line) {
      this.pendingContainer.removeChild(line);
      this.pendingToolLines.delete(id);
    }
  }

  private applyUsage(data: Record<string, unknown>): void {
    const prompt = data.promptTokens;
    const completion = data.completionTokens;
    const cached = data.cachedTokens;
    if (typeof prompt === 'number') {
      this.usage.promptTokens += prompt;
      this.contextTokens = prompt;
    }
    if (typeof completion === 'number') this.usage.completionTokens += completion;
    if (typeof cached === 'number') this.usage.cachedTokens += cached;
    this.currentIndicator?.setTokens(this.contextTokens);
  }

  private recordAuxUsage(usage: TokenUsage, purpose: string): void {
    this.session.appendEvent('usage', { ...usage, purpose });
  }

  private refreshCounters(): void {
    const totals = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
    let lastPrompt: number | undefined;
    for (const record of this.session.readAll()) {
      if (record.type !== 'event' || record.kind !== 'usage') continue;
      const prompt = record.data.promptTokens;
      const completion = record.data.completionTokens;
      const cached = record.data.cachedTokens;
      if (typeof prompt === 'number') {
        totals.promptTokens += prompt;
        lastPrompt = prompt;
      }
      if (typeof completion === 'number') totals.completionTokens += completion;
      if (typeof cached === 'number') totals.cachedTokens += cached;
    }
    this.usage = totals;
    this.contextTokens = lastPrompt;
  }

  // ------------------------------------------------------------------ 视图辅助

  private addNotice(text: string, level: 'dim' | 'warn' | 'error' | 'success' = 'dim'): void {
    this.breakToolGroup();
    const color = level === 'error' ? 'error' : level === 'warn' ? 'warning' : level === 'success' ? 'success' : 'dim';
    // 提示行与用户消息/助手正文/工具汇总共用同一条块间距（BLOCK_GAP）：以前它紧贴上一块，
    // 是转录里唯一一处 0 行间隔。
    this.chatContainer.addChild(new Spacer(BLOCK_GAP));
    this.chatContainer.addChild(new Text(theme.fg(color, ` ${text}`), 0, 0));
    // 内联菜单等异步流程经 Promise resolve 恢复时，晚于菜单关闭那次 nextTick 渲染；
    // 这里必须自行触发重渲染，否则新提示与头部数据要等下一次按键才上屏。
    this.ui.requestRender();
  }

  private setStatusIndicator(indicator: WorkingStatusIndicator | undefined): void {
    // Loader 内部有动画定时器：换掉旧指示器时必须显式停掉，否则进程会被这个
    // interval 一直吊住（退出后不结束）。
    this.currentIndicator?.dispose();
    this.currentIndicator = indicator;
    this.activityLabel = undefined;
    this.workingWarningKey = undefined;
    this.workingWarningCount = 0;
    // 状态行常驻输入框上方：空闲时两行占位，工作时换成转圈 + 活动 + 阶段耗时，
    // 右侧本轮耗时与 token。两种形态同为两行，切换时高度不变。
    this.statusContainer.clear();
    this.statusContainer.addChild(indicator ?? this.idleStatus);
  }

  private currentIndicator?: WorkingStatusIndicator;
  /** 当前状态行文案；措辞未变时不重复 setMessage，流式增量不会每帧重设同一句。 */
  private activityLabel?: string;
  /** 本轮最近一条工作状态警告（已去掉 Retrying 前缀），用来累计次数。 */
  private workingWarningKey?: string;
  private workingWarningCount = 0;

  /** 切换状态行文案。只在轮次进行中有意义（空闲时没有指示器可改）。 */
  private setActivity(message: string): void {
    if (this.activityLabel === message) return;
    this.activityLabel = message;
    this.currentIndicator?.setMessageColor((text) => theme.fg('muted', text));
    this.currentIndicator?.setShimmer(true);
    this.currentIndicator?.setMessage(message);
  }

  /**
   * 复制反馈显示在输入框右上角（状态行右侧）：提示文案优先，期间的耗时/token 让位。
   * 工作态落在 Loader、空闲态落在 IdleStatus 占位行——同一时刻 statusContainer 只挂一个，二选一生效。
   */
  private showCopyHint(message: string): void {
    this.idleStatus.showHint(message);
    this.currentIndicator?.showHint(message);
  }

  /**
   * 把 warn 写进工作状态行。同一条警告本轮累加 `(N)`；换文案从 1 重新计。
   * 没有指示器（轮次已结束）时返回 false，调用方退回转录 notice。
   */
  private showWorkingWarning(text: string): boolean {
    if (!this.currentIndicator) return false;
    const key = workingWarningKey(text);
    if (this.workingWarningKey === key) this.workingWarningCount += 1;
    else {
      this.workingWarningKey = key;
      this.workingWarningCount = 1;
    }
    const label = formatWorkingWarning(text, this.workingWarningCount);
    this.activityLabel = label;
    this.currentIndicator.setShimmer(false);
    this.currentIndicator.setMessageColor((content) => theme.fg('warning', content));
    this.currentIndicator.setMessage(label);
    return true;
  }

  private toggleToolExpansion(): void {
    const expand = !this.toolGroups.some((group) => group.isExpanded());
    for (const group of this.toolGroups) group.setExpanded(expand, false);
    this.ui.requestRender();
  }

  /**
   * Ctrl+C：有轮次在跑时中断它；否则清空输入，一秒内连按两次退出整个 TUI。
   *
   * 中断（含「立刻再按一次退出」）与 Esc 同源，都走 handleInterrupt，两者只是触发时机不同。
   */
  private handleCtrlC(): void {
    const now = Date.now();
    if (now - this.lastSigintAt < 1000) {
      this.quit();
      return;
    }
    this.lastSigintAt = now;
    if (this.lastSigintTimer) clearTimeout(this.lastSigintTimer);
    this.lastSigintTimer = setTimeout(() => {
      this.lastSigintTimer = undefined;
    }, 1200);

    // 有轮次在跑时，一次 Ctrl+C 即中断，与 Esc 等价（终止提示由 handleInterrupt 给出）。
    // 计时器已在上方记录，所以「中断 + 立刻再按一次」仍可退出。
    if (this.abort) {
      this.handleInterrupt();
      this.ui.requestRender();
      return;
    }

    if (this.editor.getText() !== '') {
      this.editor.setText('');
      this.addNotice('Cleared input — press Ctrl+C again to quit.', 'dim');
    } else {
      this.addNotice('Press Ctrl+C again to quit.', 'dim');
    }
    this.ui.requestRender();
  }

  private quit(): void {
    if (this.quitting) return;
    this.quitting = true;
    this.abort?.abort();
    if (this.lastSigintTimer) clearTimeout(this.lastSigintTimer);
    // 轮询定时器必须显式停掉，否则进程会被它一直吊住（与状态指示器的动画定时器同因）。
    if (this.recapTimer) clearInterval(this.recapTimer);
    this.recapTimer = undefined;
    this.setStatusIndicator(undefined);
    this.ui.stop({ preserveScreen: true });
    this.quitResolve?.();
  }

  // ------------------------------------------------------------------ 数据提供者

  private headerData(): import('./components/header.js').HeaderData {
    return {
      version: readVersion(),
      workspaceRoot: this.deps.workspaceRoot,
      gitBranch: this.gitBranch,
      sessionId: this.session.id,
      model: this.model,
      effort: this.effort,
      approvalMode: this.approval,
      sandboxMode: this.deps.sandbox.status.mode,
      mcpServerCount: this.deps.mcp.listServers().length,
    };
  }

  private footerData(): FooterData {
    return {
      cwd: this.deps.workspaceRoot,
      gitBranch: this.gitBranch,
      model: this.model,
      effort: this.effort,
      contextWindow: this.contextWindow,
      contextTokens: this.contextTokens,
      usage: this.usage,
    };
  }

  // ------------------------------------------------------------------ ApprovalUi

  approvalMode(): ApprovalMode {
    return this.approval;
  }

  async requestApproval(request: ApprovalRequest, note?: string): Promise<boolean> {
    const detail = flattenWhitespace(request.command ?? request.path ?? '(no detail)');
    const preview = detail.length > 400 ? `${detail.slice(0, 400)}…` : detail;
    const body = note ? `${preview}\n\n${theme.fg('warning', note)}` : preview;
    // 两个「总是允许」的作用域不一样，文案必须写出来：一个活到进程结束，一个写进
    // ~/.sph/permissions.json 并且只对当前项目生效。
    const scope = this.approvalScopeLabel(request);
    const choice = await showSelectDialog(this.ui, {
      title: `Approve ${request.tool}?`,
      bodyText: body,
      items: [
        { value: 'allow', label: 'Allow once' },
        { value: 'session', label: `Allow ${scope} for this session` },
        { value: 'always', label: `Always allow ${scope} for this project` },
        { value: 'deny', label: 'Deny' },
      ],
      maxVisible: 4,
    });
    if (choice === 'session') {
      this.approver.allowForSession(request);
      return true;
    }
    if (choice === 'always') {
      this.approver.allowForProject(request);
      return true;
    }
    return choice === 'allow';
  }

  /**
   * 「总是允许」的作用域描述（`this exact command` / `fs.read_file` / `writes to …`）。
   *
   * 必须把粒度写出来：这一项曾经写的是 `Always allow shell this session`，而记下来的键是
   * 工具名——两者合起来会让人以为「只批准了眼前这条命令」，实际签出的是整个工具。文案和
   * 键必须描述同一件事，所以这里的每个分支都和 approvalScopeKey 对应。
   */
  private approvalScopeLabel(request: ApprovalRequest): string {
    switch (request.tool) {
      case 'bash':
      case 'pwsh':
        return 'this exact command';
      case 'mcp':
        return request.command ?? 'this tool';
      case 'escalate':
        return `writes to ${request.path ?? 'this path'}`;
      default:
        return request.tool;
    }
  }

  async requestAnswer(question: string): Promise<string> {
    const answer = await showInputDialog(this.ui, {
      title: 'Question',
      initialValue: '',
      hint: `Enter submit · Esc skip\n${question}`,
    });
    return answer ?? '';
  }

  // ------------------------------------------------------------------ 命令

  private async openCommandPalette(): Promise<void> {
    const items: SelectItem[] = COMMANDS.map((command) => ({
      value: command.id,
      label: command.label,
      description: command.hint,
    }));
    const selected = await this.editor.showInlineMenu({ title: 'Commands', items, maxVisible: 14, primaryColumnWidth: primaryColumnWidthFor(items) });
    if (selected) await this.handleCommand(`/${selected.value}`);
  }

  private async handleCommand(input: string): Promise<void> {
    const [rawName, ...rest] = input.slice(1).split(/\s+/);
    const name = COMMAND_ALIASES[rawName.toLowerCase()] ?? rawName.toLowerCase();
    const argument = rest.join(' ').trim();

    if (!COMMAND_NAMES.has(name)) {
      this.addNotice(`Unknown command: /${name} — type /help`, 'warn');
      return;
    }

    switch (name) {
      case 'help':
        await this.commandHelp();
        break;
      case 'new':
        await this.commandNewSession();
        break;
      case 'resume':
        await this.commandResume(argument);
        break;
      case 'skills':
        await this.commandSkills();
        break;
      case 'mcps':
        await this.commandMcps();
        break;
      case 'plan':
        await this.commandPlan(argument);
        break;
      case 'goal':
        await this.commandGoal(argument);
        break;
      case 'compact':
        await this.commandCompact(argument);
        break;
      case 'model':
        await this.commandModel(argument);
        break;
      case 'provider':
        await this.commandProvider(argument);
        break;
      case 'effort':
        await this.commandEffort(argument);
        break;
      case 'permission':
        await this.commandPermission(argument);
        break;
      case 'export':
        await this.commandExport(argument);
        break;
      case 'exit':
        this.quit();
        break;
      default:
        break;
    }
  }

  private async commandHelp(): Promise<void> {
    const lines: string[] = [];
    lines.push('## Commands');
    for (const command of COMMANDS) lines.push(`- \`${command.label}\` — ${command.hint}`);
    // 别名不进上面的清单（与 grok-build 一致，菜单只列正名），但必须写出来，
    // 否则靠旧名字找到这里的人会以为命令被删了。
    const aliases = Object.entries(COMMAND_ALIASES).map(([alias, canonical]) => `\`/${alias}\` → \`/${canonical}\``);
    if (aliases.length > 0) lines.push(`- Aliases: ${aliases.join(' · ')}`);
    lines.push('');
    lines.push('## Key bindings');
    lines.push('- `Esc` — before the model replies, cancel and restore the prompt to the input; after it starts, interrupt output; or close a dialog');
    lines.push('- `Ctrl+C` — same interrupt as Esc while a turn is running; with no turn running, clear the input, and press it twice to quit');
    lines.push('- `Ctrl+D` — quit when the input is empty');
    lines.push('- `Ctrl+O` — expand or collapse tool output');
    lines.push('- `Ctrl+P` — open the command palette');
    lines.push('- `/` — slash-command autocomplete in the editor');
    lines.push('- `Enter` while a turn is running — queue steering (injected after the current step)');
    lines.push('- `Alt+Enter` — queue a follow-up that starts after this turn');
    await showMessageDialog(this.ui, { title: 'Help', text: lines.join('\n') });
  }

  /**
   * 重新扫一遍技能目录，而不是复用本轮提示词里那份目录。
   *
   * 会话中途新建一个 skill 是正常用法，当场扫就能立刻看到；代价只是读几个 SKILL.md 的文件头。
   * 与当前轮次提示词有分歧时以本弹窗为准——下一轮的提示词就会跟上。
   */
  private async commandSkills(): Promise<void> {
    const { catalog, warnings } = scanSkills(this.deps.workspaceRoot);
    await showMessageDialog(this.ui, {
      title: 'Skills',
      text: renderSkillsReport({ catalog, warnings, roots: skillRoots(this.deps.workspaceRoot) }),
      hint: 'Esc close · re-scanned on every open',
    });
  }

  /**
   * MCP 管理器。
   *
   * 「选一次 → 做一件事 → 重新选」的循环，而不是一次性只读弹窗：改完开关要能立刻看到新
   * 状态，否则用户只能反复敲命令来确认刚才那一下到底生效没有。Esc 退出。
   *
   * 每一轮都重新取状态：server 崩溃后的懒重连、以及外部配置的改动都会改变它。
   */
  private async commandMcps(): Promise<void> {
    for (;;) {
      const servers = this.deps.mcp.listServers();
      const choice = await showSelectDialog(this.ui, {
        title: `MCP servers (${servers.length})`,
        maxVisible: 14,
        hint: 'Enter act · Esc close',
        items: [
          { value: 'reload', label: 'Reload from disk', description: 're-read every source and reconnect' },
          { value: 'report', label: 'Show full report', description: 'sources scanned, warnings, per-server tools' },
          { value: 'add', label: 'Add a server…', description: `append to ${this.deps.configPath}` },
          ...servers.map((server) => ({
            value: `server:${server.name}`,
            label: `${server.name} — ${mcpStateLabel(server)}`,
            description: `${server.target} · from ${server.origin.label}`,
          })),
        ],
      });
      if (choice === undefined) return;
      if (choice === 'report') {
        await showMessageDialog(this.ui, {
          title: 'MCP servers',
          text: renderMcpReport({
            servers: this.deps.mcp.listServers(),
            warnings: [...(this.deps.mcpWarnings ?? [])],
            sources: [...this.deps.mcpSources()],
          }),
          hint: 'Esc close · status is live',
        });
        continue;
      }
      if (choice === 'reload') {
        await this.reloadMcpWithNotice();
        continue;
      }
      if (choice === 'add') {
        await this.addMcpServer();
        continue;
      }
      await this.manageMcpServer(choice.slice(SERVER_PREFIX.length));
    }
  }

  /**
   * 重载 MCP，并把结果讲清楚。
   *
   * 只说「已重载」等于没说：用户关心的是**哪个**连上了、哪个被关掉了。
   */
  private async reloadMcpWithNotice(): Promise<void> {
    const result = await this.deps.reloadMcp();
    const parts: string[] = [];
    if (result.added.length > 0) parts.push(`+ ${result.added.join(', ')}`);
    if (result.restarted.length > 0) parts.push(`~ ${result.restarted.join(', ')}`);
    if (result.removed.length > 0) parts.push(`- ${result.removed.join(', ')}`);
    this.addNotice(
      parts.length === 0 ? 'MCP: reloaded, nothing changed' : `MCP: reloaded · ${parts.join(' · ')}`,
      'dim',
    );
    for (const warning of this.deps.mcpWarnings ?? []) this.addNotice(warning, 'warn');
  }

  private async addMcpServer(): Promise<void> {
    const rawName = await showInputDialog(this.ui, {
      title: 'Server name',
      hint: 'letters, digits, - and _ · Esc cancel',
    });
    if (rawName === undefined) return;
    const name = rawName.trim();
    // 名字会进 TOML、也会成为工具命名空间，限制字符集比事后处理转义简单得多。
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      this.addNotice(`Invalid server name (letters, digits, - and _ only): ${name}`, 'warn');
      return;
    }
    const rawLine = await showInputDialog(this.ui, {
      title: `Command for ${name}`,
      hint: 'e.g. npx -y @modelcontextprotocol/server-filesystem . · quote paths with spaces',
    });
    if (rawLine === undefined) return;
    const parsed = splitCommandLine(rawLine.trim());
    if (parsed === undefined) {
      this.addNotice('Unbalanced quotes in that command — nothing written.', 'warn');
      return;
    }
    upsertSphMcpServer(this.deps.configPath, { name, command: parsed.command, args: parsed.args });
    this.addNotice(`Added ${name} to ${this.deps.configPath}`, 'success');
    await this.reloadMcpWithNotice();

    // 写进去却被项目级同名条目盖住是「设置不生效」的典型来源，必须当场说出来。
    const written = this.deps.mcp.listServers().find((server) => server.name === name);
    if (written !== undefined && written.origin.path !== this.deps.configPath) {
      this.addNotice(
        `${name} is overridden by ${written.origin.label} (closer/project config wins)`,
        'warn',
      );
    }
  }

  private async manageMcpServer(name: string): Promise<void> {
    const server = this.deps.mcp.listServers().find((item) => item.name === name);
    if (server === undefined) return; // 列表是上一轮取的，条目可能已经不在了
    type Action = { value: string; label: string; description?: string };
    const items: Action[] = [
      {
        value: 'toggle',
        label: server.enabled ? 'Disable' : 'Enable',
        // 外部来源只读，开关记在 sph 自己的配置里——写别人的文件是不可逆的副作用。
        description: server.origin.editable
          ? `edit ${server.origin.path}`
          : `recorded in ${this.deps.configPath} as a local preference`,
      },
    ];
    if (server.connected) {
      items.push({ value: 'tools', label: 'Show tools', description: `${server.tools.length} available` });
    }
    if (server.origin.editable) {
      items.push({ value: 'remove', label: 'Remove from config', description: server.origin.path });
    }
    const action = await showSelectDialog(this.ui, {
      title: `${server.name} — ${mcpStateLabel(server)}`,
      bodyText: `${server.target}\nfrom ${server.origin.label}`,
      items,
      maxVisible: 4,
    });

    if (action === 'toggle') {
      const enabled = !server.enabled;
      setSphMcpPreference(this.deps.configPath, server.name, {
        enabled,
        sourceEnabled: server.sourceEnabled ?? server.enabled,
      });
      this.deps.refreshMcpPreferences();
      await this.reloadMcpWithNotice();
      return;
    }
    if (action === 'tools') {
      await showMessageDialog(this.ui, {
        title: `${server.name} tools`,
        text: renderMcpTools(server),
        hint: 'Esc close',
      });
      return;
    }
    if (action === 'remove') {
      const confirmed = await showConfirmDialog(this.ui, {
        title: `Remove ${server.name}?`,
        message: `This deletes the entry from ${server.origin.path}. Nothing else is touched.`,
        confirmLabel: 'Remove',
      });
      if (!confirmed) return;
      const removed = removeSphMcpServer(server.origin.path, server.name);
      this.addNotice(
        removed ? `Removed ${server.name} from ${server.origin.path}` : `${server.name} was already gone`,
        removed ? 'success' : 'warn',
      );
      // 名字没了，可能还留着一条只认识它的本地偏好；留着会在同名条目重新出现时突然生效。
      setSphMcpPreference(this.deps.configPath, server.name, { enabled: true, sourceEnabled: true });
      this.deps.refreshMcpPreferences();
      await this.reloadMcpWithNotice();
    }
  }

  /**
   * 把外部来源的 server 固化进 sph 自己的配置。
   *
   * 两条路径都要能走：外部来源平时是**静默读取**的（保持无缝），但一旦用户决定「就按现在
   * 这份来」，继续同时读两处就会让外部文件日后的改动继续悄悄影响运行时。导入即截止。
   *
   * 落点可选：用户级适合个人常用的 server，项目级适合要跟着仓库提交、给同事共享的。
   * 传 undefined 走用户级。
   */
  private async commandNewSession(): Promise<void> {
    const confirmed = await showConfirmDialog(this.ui, {
      title: 'Start a new session?',
      message: 'The current conversation stays on disk and can be resumed later.',
      confirmLabel: 'New session',
      cancelLabel: 'Cancel',
    });
    if (!confirmed) return;
    const next = createSession(this.deps.sessionDir, this.deps.workspaceRoot);
    try {
      this.deps.claimSession?.(next.id);
    } catch (error) {
      this.addNotice(errorMessage(error), 'warn');
      return;
    }
    this.session = next;
    this.clearChat();
    this.goal = undefined;
    this.lastFailure = undefined;
    this.plan.active = false;
    this.applyEditorBorder();
    this.resetRecapState();
    this.refreshCounters();
    this.addNotice(`Started session ${this.session.id}`, 'success');
  }

  private async commandExport(argument: string): Promise<void> {
    const format = argument === 'json' || argument === 'html' ? argument : 'md';
    const body = format === 'json'
      ? exportJson(this.session)
      : format === 'html'
        ? exportHtml(this.session)
        : exportMarkdown(this.session);
    await showMessageDialog(this.ui, {
      title: `Export (${format})`,
      text: `\`\`\`\n${body.slice(0, 12_000)}${body.length > 12_000 ? '\n…' : ''}\n\`\`\``,
    });
  }

  /**
   * `/resume [id]`：带 id 前缀匹配直接切换，不带 id 打开选择器。
   *
   * 为什么保留 id 参数：sph 的内联选择器是纯列表模态，除 ↑↓/Enter/Esc 外一律吞键，
   * 没法像 grok-build 那样「在选择器里粘贴 id 直接加载」，所以「按 id 直达」只剩参数
   * 这一条路。正名与 CLI 的 `sph --resume <id>` 对齐，`/sessions` 保留为别名。
   *
   * 只有主会话可选。子代理会话是主会话跑出来的内部转录（同一个目录、独立文件），
   * 切进去等于把某次 subagent 的中间过程当成一段独立对话继续，语义上不成立；
   * 按 id 精确查找时要把它们一起捞出来，才能区分「不存在」和「是子代理会话」，
   * 否则用户从工具详情里抄来的子会话 id 只会得到一句「没有匹配的会话」。
   */
  private async commandResume(id: string): Promise<void> {
    if (id !== '') {
      const sessions = await listSessions(this.deps.sessionDir, { includeSubagents: true });
      const match = sessions.find((info) => info.id === id || info.id.startsWith(id));
      if (!match) {
        this.addNotice(`No session matching "${id}".`, 'warn');
        return;
      }
      if (match.parentId !== undefined) {
        this.addNotice(
          `Session ${match.id} is a subagent session of ${match.parentId} — /resume ${match.parentId} opens the main session.`,
          'warn',
        );
        return;
      }
      if (match.id === this.session.id) {
        this.addNotice('Already on that session.', 'dim');
        return;
      }
      this.switchSession(match.id);
      return;
    }

    const sessions = await listSessions(this.deps.sessionDir);
    if (sessions.length === 0) {
      this.addNotice('No sessions yet.', 'dim');
      return;
    }
    const items: SelectItem[] = sessions.map((info) => ({
      value: info.id,
      label: `${info.id}${info.id === this.session.id ? '  (current)' : ''}`,
      description: `${new Date(info.mtimeMs).toISOString().replace('T', ' ').slice(0, 16)} · ${info.messages} msgs${this.subagentCountLabel(info.subagents)} · ${info.preview}`,
    }));
    const selected = await this.editor.showInlineMenu({ title: 'Sessions', items, maxVisible: 12, primaryColumnWidth: primaryColumnWidthFor(items) });
    if (!selected || selected.value === this.session.id) return;
    this.switchSession(selected.value);
  }

  /** 列表里主会话的副标题后缀：让「这个会话派过几个子代理」可见。 */
  private subagentCountLabel(count: number): string {
    return count === 0 ? '' : ` · ${count} subagent${count === 1 ? '' : 's'}`;
  }

  /** 切到指定会话并把状态从日志回放出来；调用方负责过滤「已在该会话」。 */
  private switchSession(id: string): void {
    try {
      this.deps.claimSession?.(id);
    } catch (error) {
      this.addNotice(errorMessage(error), 'warn');
      return;
    }
    this.session = new JsonlSession(this.deps.sessionDir, id);
    setCurrentSession(this.deps.sessionDir, id, this.deps.workspaceRoot);
    this.clearChat();
    this.resetRecapState();
    this.restoreSession();
    this.refreshCounters();
    this.addNotice(`Switched to session ${id}`, 'success');
  }

  /**
   * 换会话/新建时的 recap 状态复位：水印由回放重新折叠（新会话为 0），
   * 空闲计时归零，否则换过去的第一秒就可能被判定成「离开过」。
   */
  private resetRecapState(): void {
    this.lastRecapMainTurn = 0;
    this.lastActivityAt = Date.now();
    this.pendingRecap = undefined;
    this.recapEpoch++;
  }

  // ------------------------------------------------------------------ Compact

  /**
   * `/compact [instructions]`：立刻把历史压成一个检查点，不等水位线。
   *
   * 与自动压缩共用 `projectContext`，区别只在于走 `force`——水位线判断的是「估算」，
   * 用户主动要求时估算不该有否决权（估算可能因为分词口径不同而偏乐观）。
   *
   * 落地方式与 loop 完全一致：只往会话里写一条 `compaction` 事件，不碰内存态。下一轮
   * `runTurn` 启动时由 `loadCompaction` 读回来，所以这里不需要维护任何投影状态，
   * 也不会出现「命令改了状态、下一轮又按旧状态发请求」的错位。
   *
   * 带参数时是**聚焦说明**（对齐 grok-build 的 `/compact compaction instructions`）：
   * 只改这一次摘要的重点，不改固定段落结构。
   */
  private async commandCompact(instructions: string): Promise<void> {
    if (this.running) {
      this.addNotice('A turn is running — wait for it to finish before compacting.', 'warn');
      return;
    }
    const messages = this.session.readMessages();
    if (messages.length === 0) {
      this.addNotice('Nothing to compact yet.', 'dim');
      return;
    }

    const covered = loadCompaction(this.session)?.covered ?? 0;
    // 摘要是同步等 LLM 的，要几秒；没有反馈用户会以为命令没生效。
    const indicator = new WorkingStatusIndicator(this.ui, WorkingLabel.compacting);
    this.setStatusIndicator(indicator);
    this.setActivity(WorkingLabel.compacting);
    try {
      const projection = await projectContext({
        ...this.sessionContext(messages),
        // 展开会把 messages 收窄成 readonly（RecapContext 的只读契约），传回原数组本身。
        messages,
        client: this.compactClient ?? this.client,
        force: true,
        instructions,
        tools: (this.deps.tools ?? defaultTools).schemas(),
        onCompacting: () => this.setActivity(WorkingLabel.compacting),
        // 摘要的花费也是真花钱，和自动路径一样记进账。
        onUsage: (usage) => this.recordAuxUsage(usage, 'compaction'),
      });
      const next = projection.compaction;
      if (!next || next.covered <= covered) {
        this.addNotice('Nothing new to compact — the recent history is kept as-is.', 'dim');
        return;
      }
      this.session.appendEvent('compaction', { summary: next.summary, covered: next.covered });
      this.addNotice(`Compacted ${next.covered - covered} messages into a checkpoint.`, 'success');
    } catch (error) {
      this.addNotice(`Compact failed: ${message(error)}`, 'error');
    } finally {
      this.setStatusIndicator(undefined);
      this.setActivity(WorkingLabel.working);
    }
  }

  // ------------------------------------------------------------------ Recap

  /** 空闲轮询：离开够久就预生成一次 recap，用户回来时它已经在那儿了。 */
  private startRecapWatch(): void {
    if (this.recapTimer) return;
    this.recapTimer = setInterval(() => {
      void this.maybeAutoRecap();
    }, RECAP_WATCH_INTERVAL_MS);
  }

  /**
   * 自动 recap 的资格判定。
   *
   * 参考实现靠终端焦点事件判断「用户离开过」；sph 的输入层没有焦点上报，改用空闲时长近似
   * ——效果一致（离开期间就绪），代价是不必给整条输入解析链加焦点协议。
   * 真正的条件（轮次下限、距上次 recap 有新轮次、空闲够久）都在 recapGate 里，
   * 这里只负责「现在能不能安全地发这一次调用」。
   */
  private async maybeAutoRecap(): Promise<void> {
    if (this.quitting || this.running || this.recapInFlight) return;
    // 空闲没到就直接返回：下面要读整个会话文件，轮询每 30s 一次不该白白付这份 IO。
    if (Date.now() - this.lastActivityAt < RECAP_IDLE_MS) return;
    if (this.ui.hasOverlay()) return;
    // 后台子代理还在跑时不 recap：它会继续写会话，摘要马上就过时。
    if (this.subagentLines.size > 0) return;
    if (Date.now() < this.recapRetryAfter) return;
    // 退避在**派发前**记下：闸门被拒也算一次尝试，否则会退化成每 30s 一次的全量读盘。
    this.recapRetryAfter = Date.now() + AUTO_RECAP_RETRY_MS;
    await this.commandRecap(true);
  }

  /**
   * 生成一次 recap。`auto` 只影响三处：闸门更严、不显示 pending 占位、长尾输出可被抑制。
   * 生成过程对会话只读——成功才落一条 `recap` 事件（既是留档也是水印）。
   */
  private async commandRecap(auto: boolean): Promise<void> {
    const messages = this.session.readMessages();
    const mainTurns = mainTurnCount(messages);
    const idleOk = Date.now() - this.lastActivityAt >= RECAP_IDLE_MS;

    const gate = recapGate(mainTurns, this.lastRecapMainTurn, auto, idleOk);
    if (!gate.ok) {
      if (!auto) this.addNotice(this.recapGateNotice(gate.reason), 'dim');
      return;
    }
    if (this.recapInFlight) {
      if (!auto) this.addNotice('A recap is already being generated.', 'dim');
      return;
    }

    this.recapInFlight = true;
    const epoch = this.recapEpoch;
    // 手动路径先挂 pending 行：生成要几秒，没有反馈用户会以为命令没生效。
    const block = auto ? undefined : this.startRecapBlock();
    try {
      const result = await generateRecap(this.sessionContext(messages), {
        // 用会话模型而不是压缩小模型：recap 的全部价值就在于复用主轮次的提示词前缀，
        // 换模型等于换缓存，省下的钱还不够丢掉命中缓存的差价。
        client: this.client,
        onUsage: (usage) => this.recordAuxUsage(usage, 'recap'),
      });

      if (this.recapEpoch !== epoch) {
        // 生成期间用户又发了一轮：整块丢弃，**不推进水印**——这一轮之后自动 recap
        // 仍然可以再试（对齐 grok-build：只有成功或被抑制的自动 recap 才算提交）。
        this.dropRecapBlock(block);
        if (!auto) this.addNotice('Recap dropped — a new turn started while it was generating.', 'dim');
        return;
      }

      // 自动 recap 的长尾输出（跑飞/被硬截断）只留档不上屏；手动 recap 始终展示。
      if (auto && shouldSuppressAutoRecapDisplay(result.raw, result.summary)) {
        this.commitRecap(result.summary, auto, mainTurns, false);
        this.dropRecapBlock(block);
        return;
      }

      this.commitRecap(result.summary, auto, mainTurns, true);
      if (block) block.setSummary(result.summary);
      else this.addRecap(result.summary);
    } catch (error) {
      // recap 是旁路功能：失败只提示，绝不打断会话，也不推进水印（下次还能再试）。
      this.dropRecapBlock(block);
      if (!auto) this.addNotice(`Recap failed: ${message(error)}`, 'error');
    } finally {
      this.recapInFlight = false;
      this.ui.requestRender();
    }
  }

  /** 闸门拒绝的原因 → 用户可读的一句话（只在手动路径展示，自动路径静默）。 */
  private recapGateNotice(reason: string): string {
    if (reason === 'no main turns yet') return 'Nothing to recap yet — send a message first.';
    return 'Nothing new to recap yet.';
  }

  /**
   * 组装只读上下文（recap 与 `/compact` 共用）。
   *
   * 系统提示词必须与 runTurn 的同参构造，前缀缓存才命中——所以这份构造只能有一处。
   */
  private sessionContext(messages: ReturnType<JsonlSession['readMessages']>): RecapContext {
    return {
      messages,
      compaction: loadCompaction(this.session),
      system: buildSystemPrompt({
        workspaceRoot: this.deps.workspaceRoot,
        model: this.model,
        sandbox: this.deps.sandbox.status.mode,
        skills: scanSkills(this.deps.workspaceRoot).catalog,
        mcpTools: this.deps.mcp.listTools(),
        // goal / lastFailure / planMode 与 runTurn 同参：不进 system（前缀最头部），
        // 跨轮次状态由 runTurn 以尾部 user 消息注入。
      }),
      contextWindow: this.contextWindow,
    };
  }

  /** 落一条 recap 事件：既是留档（/status、回放），也是自动 recap 的水印。 */
  private commitRecap(summary: string, auto: boolean, mainTurns: number, shown: boolean): void {
    this.session.appendEvent('recap', sessionEventData.recap({ summary, auto, mainTurns, shown }));
    this.lastRecapMainTurn = mainTurns;
  }

  /** 手动 recap 的 pending 行：拿到结果后原地换正文，失败/取消时整块撤掉。 */
  private startRecapBlock(): RecapMessageComponent {
    this.breakToolGroup();
    const block = new RecapMessageComponent('', true);
    this.chatContainer.addChild(block);
    this.pendingRecap = block;
    this.ui.requestRender();
    return block;
  }

  private dropRecapBlock(block: RecapMessageComponent | undefined): void {
    if (!block) return;
    this.chatContainer.removeChild(block);
    if (this.pendingRecap === block) this.pendingRecap = undefined;
    this.ui.requestRender();
  }

  /** 把一行 recap 摘要挂进对话流。 */
  private addRecap(summary: string): void {
    this.breakToolGroup();
    this.chatContainer.addChild(new RecapMessageComponent(summary));
    this.ui.requestRender();
  }

  private writePlanMode(active: boolean): void {
    if (this.plan.active === active) {
      this.addNotice(active ? 'Already in plan mode. /plan off to leave.' : 'Plan mode is already off.', 'dim');
      return;
    }
    this.plan.active = active;
    this.applyEditorBorder();
    this.session.appendEvent('plan_mode', sessionEventData.planMode(active));
    this.addNotice(
      active
        ? 'Plan mode on. Explore and design; writes are blocked until the plan is approved. /plan off to leave.'
        : 'Plan mode off.',
      'success',
    );
    this.ui.requestRender();
  }

  private async commandPlan(argument: string): Promise<void> {
    if (argument === 'off') {
      this.writePlanMode(false);
      return;
    }
    if (!this.plan.active) this.writePlanMode(true);
    else if (argument === '') this.addNotice('Already in plan mode. /plan off to leave.', 'dim');
    if (argument === '') return;
    if (this.running) {
      this.addNotice('A turn is already running — the next step will use plan mode. Press Esc to interrupt.', 'warn');
      return;
    }
    await this.executeTurn(argument);
  }

  private async reviewPlan(plan: string, title: string): Promise<{ approved: boolean; feedback?: string }> {
    const choice = await showSelectDialog(this.ui, {
      title,
      bodyText: plan,
      items: [
        { value: 'approve', label: 'Approve', description: 'Leave plan mode and carry out the plan' },
        { value: 'revise', label: 'Keep planning', description: 'Stay in plan mode; optional feedback next' },
      ],
      maxVisible: 2,
      maxHeight: '80%',
    });
    if (choice === 'approve') return { approved: true };
    if (choice === 'revise') {
      const feedback = await showInputDialog(this.ui, {
        title: 'Feedback (optional)',
        hint: 'Enter send · Esc skip',
      });
      return { approved: false, feedback: feedback ?? '' };
    }
    return {
      approved: false,
      feedback: 'The user dismissed the plan review to speak instead; stay in plan mode, stop here, and wait for their message.',
    };
  }

  private async commandGoal(argument: string): Promise<void> {
    if (argument === '') {
      if (this.goal) {
        const choice = await showSelectDialog(this.ui, {
          title: 'Goal',
          bodyText: this.goal,
          items: [
            { value: 'keep', label: 'Keep' },
            { value: 'clear', label: 'Clear goal' },
          ],
          maxVisible: 2,
        });
        if (choice === 'clear') this.writeGoal('');
      } else {
        const text = await showInputDialog(this.ui, { title: 'Set goal', hint: 'Enter save · Esc cancel' });
        if (text) this.writeGoal(text);
      }
      return;
    }
    this.writeGoal(argument);
  }

  private writeGoal(text: string): void {
    this.goal = text.trim() === '' ? undefined : text.trim();
    this.session.appendEvent('goal', sessionEventData.goal(this.goal ?? ''));
    this.addNotice(this.goal ? `Goal set: ${this.goal}` : 'Goal cleared.', 'success');
  }

  private async commandModel(argument = ''): Promise<void> {
    if (argument !== '') {
      this.applyModel(argument);
      return;
    }
    // 候选只来自 models.json 的声明：模型目录是显式维护的清单，不再从上游拉取缓存——
    // 上游会新增模型，而拉一次就存住的缓存只会静默地给出旧列表。
    const providers = this.deps.models();
    if (providers.length === 0) {
      this.addNotice('No models declared in models.json.', 'warn');
      return;
    }
    // description 列内排三段：模型 ID / 提供商 / 状态。各段按最宽值 pad（间隙 2），
    // 加上 label 列就是四列；中文名混排时字符数不等于显示宽，按 visibleWidth 对齐才不会锯齿。
    const widthOf = (text: string): number => visibleWidth(text);
    const idColumnWidth = Math.max(...providers.flatMap((provider) => provider.models.map((row) => widthOf(row.id))));
    const providerColumnWidth = Math.max(...providers.map((provider) => widthOf(provider.name)));
    const labelColumnWidth = Math.max(
      ...providers.flatMap((provider) =>
        provider.models.map((row) => widthOf(row.name ?? displayNameForModel(row.id))),
      ),
    );
    const padTo = (text: string, width: number): string => `${text}${' '.repeat(width - widthOf(text) + 2)}`;
    const items: SelectItem[] = providers.flatMap((provider) =>
      provider.models.map((declared) => {
        const value = provider.name === this.provider ? declared.id : `${provider.name}/${declared.id}`;
        const isCurrent = provider.name === this.provider && declared.id === this.model;
        return {
          value,
          label: declared.name ?? displayNameForModel(declared.id),
          description: `${padTo(declared.id, idColumnWidth)}${padTo(provider.name, providerColumnWidth)}${
            isCurrent ? 'current' : ''
          }`.trimEnd(),
        };
      }),
    );
    if (items.length === 0) {
      this.addNotice('No models declared in models.json.', 'warn');
      return;
    }
    const selected = await this.editor.showInlineMenu({
      title: 'Model',
      items,
      maxVisible: 14,
      // 主列贴内容收紧：默认 32 列会让短模型名后面拖一长条空白，四列观感才散。
      primaryColumnWidth: labelColumnWidth + 2,
    });
    if (!selected || selected.value === `${this.provider}/${this.model}`) return;
    const { provider, model } = splitProviderModel(providers, selected.value);
    this.applyModel(model, provider);
  }

  /**
   * `/provider [name]`：切换 provider 的四步向导。
   *
   * 选 provider（带参数则跳过）→ 选模型 → 选推理等级 → 选端点协议。
   * 后两步 Esc 跳过，不影响已经生效的前几步。模型候选 = 已声明 ∪ 上游目录，
   * 选到未声明的就追加进 models.json 再切换。上游拉取失败不算失败：离线时
   * 仍能在已声明模型里切换，不该被一次网络故障挡住。
   */
  private async commandProvider(argument = ''): Promise<void> {
    const providers = this.deps.models();
    // 列对齐基元：两处菜单（provider 选择、模型选择）共用同一套宽与 pad。
    const widthOf = (text: string): number => visibleWidth(text);
    const padTo = (text: string, width: number): string => `${text}${' '.repeat(width - widthOf(text) + 2)}`;
    let targetName = argument.trim();
    if (targetName === '') {
      // description 排两段：baseUrl / 状态，各按最宽值对齐，current 不会锯齿。
      const baseUrlColumnWidth = Math.max(...providers.map((provider) => widthOf(provider.baseUrl)));
      const items: SelectItem[] = providers.map((provider) => ({
        value: provider.name,
        label: provider.name,
        description: `${padTo(
          provider.baseUrl,
          baseUrlColumnWidth,
        )}${provider.name === this.provider ? 'current' : ''}`.trimEnd(),
      }));
      const selected = await this.editor.showInlineMenu({
        title: 'Provider',
        items,
        maxVisible: 14,
        primaryColumnWidth: primaryColumnWidthFor(items),
      });
      if (!selected) return;
      targetName = selected.value;
    }
    const provider = providers.find((item) => item.name === targetName);
    if (!provider) {
      this.addNotice(
        `Unknown provider: ${targetName} (declared in models.json: ${providers.map((item) => item.name).join(', ')})`,
        'warn',
      );
      return;
    }

    // 拉取过程用弹窗呈现：通知行会一闪而过且被打断，模态加载框让「正在等网络」这件事显式化。
    const loading = showLoadingDialog(this.ui, {
      title: provider.name,
      text: `Fetching models from ${provider.baseUrl}…`,
    });
    let fetched: readonly string[] = [];
    let catalogUnavailable = false;
    try {
      fetched = await listAvailableModels(provider.baseUrl, provider.apiKey, {
        headers: provider.headers,
        signal: AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      // 不少中转站没有 /models 目录端点（502 或挂住），这不是异常路径而是常态，
      // 所以把「Esc 后手动输入」一并说清，而不是只报错。
      catalogUnavailable = true;
      this.addNotice(
        `Fetch failed (${errorMessage(error)}) — the gateway may not offer a /models endpoint. Pick a declared model, or press Esc to type a model id.`,
        'warn',
      );
    } finally {
      loading.hide();
    }
    const declaredIds = new Set(provider.models.map((row) => row.id));
    // 候选 = 已声明 ∪ 上游目录去重。是否已声明对选择行为没有差别（未声明的选中即追加），
    // 所以不做 declared 标记——列表只回答「模型 ID 是什么、当前用的是哪个」两件事。
    const candidates = [
      ...provider.models.map((row) => ({ id: row.id, name: row.name })),
      ...fetched
        .filter((id) => !declaredIds.has(id))
        .map((id) => ({ id, name: undefined })),
    ];
    // description 列排两段：模型 ID / 状态，各按最宽值 pad（间隙 2），label 列随内容收紧。
    const idColumnWidth = Math.max(...candidates.map((candidate) => widthOf(candidate.id)));
    const labelColumnWidth = Math.max(
      ...candidates.map((candidate) => widthOf(candidate.name ?? displayNameForModel(candidate.id))),
    );
    const items: SelectItem[] = candidates.map((candidate) => {
      const isCurrent = provider.name === this.provider && candidate.id === this.model;
      return {
        value: candidate.id,
        label: candidate.name ?? displayNameForModel(candidate.id),
        description: `${padTo(candidate.id, idColumnWidth)}${isCurrent ? 'current' : ''}`.trimEnd(),
      };
    });
    let selected = await this.editor.showInlineMenu({
      title: `Model @ ${provider.name}`,
      items,
      maxVisible: 14,
      primaryColumnWidth: labelColumnWidth + 2,
    });
    if (!selected && catalogUnavailable) {
      // 目录拉不到时的兜底：直接键入网关侧的模型 id，随后照样追加进 models.json。
      const typed = await showInputDialog(this.ui, {
        title: `Model id @ ${provider.name}`,
        hint: 'Type the model id exactly as the gateway expects it',
      });
      if (typed === undefined || typed.trim() === '') return;
      selected = { value: typed.trim(), label: typed.trim() };
    }
    if (!selected) return;
    const modelId = selected.value;
    if (!declaredIds.has(modelId)) {
      try {
        // 只追加当前选中的这一条，不把上游目录整表写进 models.json。
        appendModelDeclaration(sphModelsPath(), provider.name, modelId);
        this.addNotice(`Declared ${modelId} under ${provider.name} in models.json.`, 'success');
      } catch (error) {
        this.addNotice(`Failed to append ${modelId} to models.json: ${errorMessage(error)}`, 'warn');
      }
    }
    this.applyModel(modelId, provider.name);
    const effort = await this.promptEffort();
    if (effort !== undefined) this.applyEffort(effort);
    const api = await this.promptApi(this.deps.resolveModel(modelId, provider.name).api);
    if (api !== undefined) this.applyApi(api, provider, modelId);
  }

  /**
   * 应用模型选择：重建 client、记事件、写回配置（可能同时切换 provider）。
   *
   * 声明了容量的模型一并生效 contextWindow / maxTokens——换模型后窗口不再是旧的；
   * 未声明的模型保持现值，兜底由 config.toml 的全局值管。
   */
  private applyModel(model: string, providerName?: string): void {
    const provider = providerName ?? this.provider;
    const resolved = this.deps.resolveModel(model, provider);
    this.provider = provider;
    this.model = model;
    if (resolved.contextWindow !== undefined) this.contextWindow = resolved.contextWindow;
    if (resolved.maxTokens !== undefined) this.maxTokens = resolved.maxTokens;
    this.client = this.buildClient();
    this.session.appendEvent(
      'model_selection',
      sessionEventData.modelSelection({ model, contextWindow: this.contextWindow, maxTokens: this.maxTokens }),
    );
    // provider 与 model 一起写回：下一个进程从 config.toml 读到的就是这次的选择。
    const error = this.writeConfig({ provider, model });
    this.addNotice(
      error ? `Model set to ${model} (config write failed: ${error})` : `Model set to ${model}`,
      error ? 'warn' : 'success',
    );
  }

  private async commandEffort(argument = ''): Promise<void> {
    if (argument !== '') {
      const match = REASONING_EFFORTS.find((effort) => effort === argument);
      if (!match) {
        this.addNotice(`Unknown effort: ${argument} (${REASONING_EFFORTS.join(' | ')})`, 'warn');
        return;
      }
      this.applyEffort(match);
      return;
    }
    const selected = await this.promptEffort();
    if (selected !== undefined) this.applyEffort(selected);
  }

  private async promptEffort(): Promise<ReasoningEffort | undefined> {
    const items: SelectItem[] = REASONING_EFFORTS.map((effort) => ({
      value: effort,
      label: effort,
      description: effort === this.effort ? 'current' : undefined,
    }));
    const selected = await this.editor.showInlineMenu({
      title: 'Reasoning effort',
      items,
      maxVisible: 6,
      primaryColumnWidth: primaryColumnWidthFor(items),
    });
    return selected === undefined ? undefined : (selected.value as ReasoningEffort);
  }

  private async promptApi(current: ApiProtocol): Promise<ApiProtocol | undefined> {
    const items: SelectItem[] = API_PROTOCOLS.map((api) => ({
      value: api,
      label: api,
      description: api === current ? 'current' : undefined,
    }));
    const selected = await this.editor.showInlineMenu({
      title: 'API protocol',
      items,
      maxVisible: 3,
      primaryColumnWidth: primaryColumnWidthFor(items),
    });
    return selected === undefined ? undefined : (selected.value as ApiProtocol);
  }

  private applyEffort(effort: ReasoningEffort): void {
    this.effort = effort;
    this.client = this.buildClient();
    const error = this.writeConfig({ reasoning_effort: effort });
    this.addNotice(
      error ? `Effort set to ${effort} (config write failed: ${error})` : `Effort set to ${effort}`,
      error ? 'warn' : 'success',
    );
  }

  /**
   * 把协议写到该模型的声明上（覆盖 provider 默认），并立刻重建 client。
   * 内存里的 registry 也改一笔，否则本进程 resolveModel 仍读到旧值。
   */
  private applyApi(api: ApiProtocol, provider: ProviderDeclaration, modelId: string): void {
    let writeError: string | undefined;
    try {
      upsertModelApi(sphModelsPath(), provider.name, modelId, api);
    } catch (error) {
      writeError = errorMessage(error);
    }
    const declared = provider.models.find((row) => row.id === modelId);
    if (declared) declared.api = api;
    else provider.models.push({ id: modelId, api });
    this.client = this.buildClient();
    this.addNotice(
      writeError === undefined ? `API set to ${api}` : `API set to ${api} (models.json write failed: ${writeError})`,
      writeError === undefined ? 'success' : 'warn',
    );
  }

  /**
   * `/permission [mode]`：无参数打开选择器，带参数直接设。
   *
   * 命令名对齐 dsh 的 `/permission`；写回的配置键仍是 `approval`——那是「审批策略」这个
   * 概念的名字，而且已经躺在用户既有的 config.toml 里，跟着改名会静默丢掉他们的设置。
   */
  private async commandPermission(argument = ''): Promise<void> {
    if (argument !== '') {
      const match = APPROVAL_MODES.find((mode) => mode === argument);
      if (!match) {
        this.addNotice(`Unknown approval mode: ${argument} (${APPROVAL_MODES.join(' | ')})`, 'warn');
        return;
      }
      this.applyApproval(match);
      return;
    }
    const items: SelectItem[] = APPROVAL_MODES.map((mode) => ({
      value: mode,
      label: mode,
      description:
        mode === 'ask'
          ? 'Ask before every reviewed tool call'
          : mode === 'auto'
            ? 'Let a model reviewer decide, escalate to you when unsure'
            : 'Approve everything automatically',
    }));
    const selected = await this.editor.showInlineMenu({ title: 'Approval mode', items, maxVisible: 3, primaryColumnWidth: primaryColumnWidthFor(items) });
    if (!selected) return;
    this.applyApproval(selected.value as ApprovalMode);
  }

  private applyApproval(mode: ApprovalMode): void {
    this.approval = mode;
    this.applyEditorBorder();
    const error = this.writeConfig({ approval: mode });
    this.addNotice(
      error ? `Approval mode set to ${mode} (config write failed: ${error})` : `Approval mode set to ${mode}`,
      error ? 'warn' : 'success',
    );
  }

  /**
   * 输入框边框：计划模式整框蓝色（失焦也蓝，跑轮次时仍能辨认）。
   * 否则失焦弱化；聚焦时 ask 品牌紫，auto 黄，yolo 红。
   */
  private applyEditorBorder(): void {
    if (this.plan.active) {
      const plan = (text: string) => theme.fg('plan', text);
      this.editor.borderColor = plan;
      this.editor.focusBorderColor = plan;
      return;
    }
    const idle = 'borderMuted';
    const focus = this.approval === 'yolo' ? 'error' : this.approval === 'auto' ? 'warning' : 'primary';
    this.editor.borderColor = (text: string) => theme.fg(idle, text);
    this.editor.focusBorderColor = (text: string) => theme.fg(focus, text);
  }

  private clearChat(): void {
    this.transcriptView?.setPinY(undefined);
    this.chatContainer.clear();
    this.toolGroups.length = 0;
    this.activeToolGroup = undefined;
    this.pendingTools.clear();
    this.streamingAssistant = undefined;
    this.pendingRecap = undefined;
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new DynamicBorder());
    this.chatContainer.addChild(
      new Text(theme.fg('dim', ` ${keyHint('app.command', 'for commands')} · ${keyHint('app.clear', 'x2 to quit')}`), 0, 0),
    );
    this.chatContainer.addChild(new DynamicBorder());
    this.chatContainer.addChild(new Spacer(1));
  }

  /** 把配置改动写回 config.toml；失败只返回原因，不打断交互。 */
  private writeConfig(patch: Readonly<Record<string, string | number>>): string | undefined {
    try {
      updateConfigFile(this.deps.configPath, patch);
      return undefined;
    } catch (error) {
      return message(error);
    }
  }

  private buildClient(): LlmClient {
    return this.deps.makeClient({
      model: this.model,
      provider: this.provider,
      effort: this.effort,
      maxTokens: this.maxTokens,
    });
  }
}
