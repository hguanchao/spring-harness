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
import { runTurn } from '../agent/loop.js';
import { TouchMemory } from '../agent/memory.js';
import { createLlmClassifier } from '../approval/auto.js';
import { APPROVAL_MODES, type ApprovalMode, type ApprovalRequest } from '../approval/policy.js';
import { updateConfigFile } from '../config/save.js';
import type { ApiProtocol } from '../config/load.js';
import {
  REASONING_EFFORTS,
  type LlmClient,
  type ReasoningEffort,
  type TokenUsage,
} from '../llm/openai.js';
import { readModelCache, writeModelCache } from '../llm/model-cache.js';
import type { McpHub } from '../mcp/hub.js';
import type { JobBoard } from '../runtime/jobs.js';
import { jobNotificationText } from '../runtime/jobs.js';
import type { WorktreeStore } from '../runtime/worktrees.js';
import { SpillStore } from '../runtime/spill.js';
import type { TodoList } from '../runtime/todos.js';
import type { SandboxHandle } from '../sandbox/open.js';
import { exportJson, exportMarkdown } from '../session/export.js';
import {
  foldSessionState,
  sessionEventData,
  type SessionFailure,
} from '../session/fold.js';
import { messagesOf } from '../session/query.js';
import {
  createSession,
  JsonlSession,
  listSessions,
  setCurrentSession,
} from '../session/store.js';
import type { SessionMessage, SessionRecord } from '../session/types.js';
import {
  BLOCK_GAP,
  CombinedAutocompleteProvider,
  Container,
  isKeyRelease,
  isViewportTUI,
  type SelectItem,
  type SlashCommand,
  Spacer,
  Text,
  type TUI,
  TuiAltScreen,
  ProcessTerminal,
  type Terminal,
  VStack,
  ScrollView,
} from './core/index.js';
import { matchesAppKey } from './app-keybindings.js';
import { InteractiveApprover, type ApprovalUi } from './approver.js';
import { showConfirmDialog, showInputDialog, showMessageDialog, showSelectDialog } from './dialogs.js';
import { readGitBranch } from './git.js';
import { AssistantMessageComponent } from './components/assistant-message.js';
import { CustomEditor } from './components/custom-editor.js';
import { FooterComponent, type FooterData } from './components/footer.js';
import { HeaderComponent } from './components/header.js';
import { DynamicBorder, IdleStatus, WorkingLabel, WorkingStatusIndicator, keyHint } from './components/interaction.js';
import { TOOL_GROUP_INDENT, TOOL_MEMBER_INDENT, ToolExecutionComponent, toolDisplayName } from './components/tool-execution.js';
import { SubagentTaskComponent } from './components/subagent-task.js';
import { ToolGroupComponent } from './components/tool-group.js';
import { UserMessageComponent } from './components/user-message.js';
import { getEditorTheme, getMarkdownTheme, theme } from './theme/theme.js';
import { errorMessage, flattenWhitespace, formatDuration } from '../util.js';
import { readVersion } from '../version.js';

export interface TuiDeps {
  workspaceRoot: string;
  sessionDir: string;
  /** config.toml 路径：/model、/effort、/approval 的选择写回这里，下次启动仍生效。 */
  configPath: string;
  /** 欢迎态底部右对齐的登录状态文案（API key / 免鉴权头）。 */
  authLabel: string;
  baseUrl: string;
  contextWindow: number;
  maxTokens?: number;
  sandbox: SandboxHandle;
  session: JsonlSession;
  mcp: McpHub;
  mcpServerCount: number;
  todos: TodoList;
  jobs: JobBoard;
  approvalMode: ApprovalMode;
  model: string;
  api: ApiProtocol;
  effort?: ReasoningEffort;
  /** /model 与 /effort 改动后按新参数重建 client。 */
  makeClient(options: { model: string; api: ApiProtocol; effort?: ReasoningEffort; maxTokens?: number }): LlmClient;
  fetchModels(): Promise<readonly string[]>;
  /** 上游模型目录的磁盘缓存路径。 */
  modelCachePath?: string;
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
  /** 子代理 worktree 隔离的工作树仓库（isolation: worktree 用）。 */
  worktrees?: WorktreeStore;
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
  { id: 'sessions', label: '/sessions', hint: 'Browse sessions, or switch by id' },
  { id: 'status', label: '/status', hint: 'Show the full status panel' },
  { id: 'goal', label: '/goal', hint: 'Set, view, or clear the goal' },
  { id: 'model', label: '/model', hint: 'Choose a model and write it to config.toml' },
  { id: 'effort', label: '/effort', hint: 'Set reasoning effort (written to config.toml)' },
  { id: 'approval', label: '/approval', hint: 'Set approval mode: ask | auto | yolo' },
  { id: 'todo', label: '/todo', hint: 'Show the to-do list' },
  { id: 'jobs', label: '/jobs', hint: 'Show background jobs' },
  { id: 'export', label: '/export', hint: 'Export this session (md | json)' },
  { id: 'clear', label: '/clear', hint: 'Clear the conversation view' },
  { id: 'quit', label: '/quit', hint: 'Quit' },
];

const COMMAND_NAMES = new Set<string>([...COMMANDS.map((command) => command.id), 'exit']);

function message(error: unknown): string {
  return errorMessage(error);
}

/** 输入框上方子代理栏最多显示几行，多出来的折成 `… N more`。 */
const MAX_DOCK_SUBAGENT_ROWS = 5;

/**
 * 子代理内部事件 → 行内活动段文案，与底部状态行共用同一套词（WorkingLabel）。
 *
 * 返回 undefined 表示这个事件不改变活动段（`tool_end` / `status` / `thinking_end` 都不改，
 * 下一步的动作会自己覆盖上来），调用方据此跳过重绘。
 */
function subagentActivity(event: SubagentEvent): string | undefined {
  switch (event.type) {
    case 'thinking_start':
    case 'thinking_delta':
      return WorkingLabel.thinking;
    case 'text':
      return WorkingLabel.responding;
    case 'tool_start':
      return WorkingLabel.running(toolDisplayName(event.name));
    case 'error':
      return flattenWhitespace(event.text).slice(0, 80);
    default:
      return undefined;
  }
}

/** 交互模式入口。 */
export async function runTui(deps: TuiDeps): Promise<void> {
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
  private readonly subagentContainer = new Container();
  private readonly subagentHeader = new Text('', 0, 0);
  private readonly statusContainer = new Container();
  private readonly editorContainer = new Container();
  private readonly footerContainer = new Container();
  private transcriptView: ScrollView | undefined;
  private readonly idleStatus = new IdleStatus();
  private readonly footer: FooterComponent;
  private readonly header: HeaderComponent;

  private session: JsonlSession;
  private client: LlmClient;
  private readonly approver: InteractiveApprover;
  private compactClient?: LlmClient;
  private reviewClient?: LlmClient;

  private model: string;
  private effort?: ReasoningEffort;
  private maxTokens?: number;
  private approval: ApprovalMode;
  private contextWindow: number;
  private goal?: string;
  private lastFailure?: SessionFailure;
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
   * 本轮模型是否已经吐出过内容（正文或思考）。
   *
   * 不能用「助手组件是否已创建」代替：`runTurn` 在把请求发给模型**之前**就先广播
   * `thinking_start`，组件那时就已经建好了，用它判断会把「还没回复」误判成「正在输出」。
   */
  private turnOutputStarted = false;
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

  constructor(deps: TuiDeps) {
    this.deps = deps;
    this.session = deps.session;
    this.model = deps.model;
    this.effort = deps.effort;
    this.maxTokens = deps.maxTokens;
    this.approval = deps.approvalMode;
    this.contextWindow = deps.contextWindow;

    this.client = this.buildClient();
    this.approver = new InteractiveApprover(
      this,
      this.approval === 'auto'
        ? createLlmClassifier(this.reviewClient ?? this.client, {
            onUsage: (usage) => this.recordAuxUsage(usage, 'review'),
          })
        : undefined,
    );

    this.ui = deps.ui ?? new TuiAltScreen(deps.terminal ?? new ProcessTerminal(), false, deps.workspaceRoot);
    this.editor = new CustomEditor(this.ui, getEditorTheme(), {
      paddingX: 1,
      autocompleteMaxVisible: 8,
    });
    this.applyApprovalBorder();

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
      scrollbarTrackStyle: (text) => theme.fg('dim', text),
      scrollbarThumbStyle: (text) => theme.fg('dim', text),
    });
    this.transcriptView = transcript;
    const dock = new VStack([
      { component: this.pendingContainer, shrink: 1, minSize: 0 },
      { component: this.subagentContainer, shrink: 1, minSize: 0 },
      { component: this.statusContainer, shrink: 1, minSize: 0 },
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
    const records = this.session.readAll();
    if (records.length === 0) return;

    this.replayRecords(records);
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
      if (child instanceof UserMessageComponent) pin = y;
      y += child.render(width).length;
    }
    view.setPinY(pin);
  }

  private replayRecords(records: readonly SessionRecord[]): void {
    const folded = foldSessionState(records);
    this.goal = folded.goal;
    this.lastFailure = folded.failures.at(-1);
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
    if (text === '') return;
    this.editor.setText('');
    this.history.push(text);

    if (text.startsWith('/')) {
      await this.handleCommand(text);
      return;
    }
    if (this.running) {
      this.addNotice('A turn is already running — press Esc to interrupt.', 'warn');
      return;
    }
    await this.executeTurn(text);
  }

  private async executeTurn(prompt: string): Promise<void> {
    this.chatContainer.addChild(new UserMessageComponent(prompt, getMarkdownTheme()));
    this.pinLatestUserMessage();
    this.ui.requestRender();

    const controller = new AbortController();
    this.abort = controller;
    this.running = true;
    this.turnOutputStarted = false;
    const indicator = new WorkingStatusIndicator(this.ui, WorkingLabel.working);
    this.setStatusIndicator(indicator);
    // 指示器已带初始文案，这里只是把 activityLabel 记上，后续 setActivity 才知道该不该重设。
    this.setActivity(WorkingLabel.working);

    try {
      await runTurn({
        prompt,
        workspaceRoot: this.deps.workspaceRoot,
        client: this.client,
        session: this.session,
        sandbox: this.deps.sandbox,
        approver: this.approver,
        contextWindow: this.contextWindow,
        depth: this.sessionDepth,
        maxSubagentDepth: this.deps.maxSubagentDepth,
        listener: this.listener,
        signal: controller.signal,
        mcp: this.deps.mcp,
        todos: this.deps.todos,
        jobs: this.deps.jobs,
        memory: new TouchMemory(this.deps.workspaceRoot),
        worktrees: this.deps.worktrees,
        goal: this.goal,
        lastFailure: this.lastFailure,
        compactClient: this.compactClient,
        onAuxUsage: (usage, purpose) => this.recordAuxUsage(usage, purpose),
        ...(this.deps.spillRoot === undefined
          ? {}
          : { spill: new SpillStore(join(this.deps.spillRoot, this.session.id), this.deps.spillThreshold) }),
      });
    } catch (error) {
      // 中断提示已由 handleInterrupt 即时给出，这里不再重复一条。
      if (!controller.signal.aborted) this.addNotice(message(error), 'error');
    } finally {
      this.finalizeStreaming();
      this.running = false;
      this.abort = undefined;
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
   * Esc：终止当前轮次。
   *
   * 模型还没吐出任何内容（含思考）时是「取消」，已经开始输出时是「打断」——两者都只中止
   * 这一轮，会话本身照常保留。没有轮次在跑时，Esc 让位给浮层做关闭。
   */
  private handleInterrupt(): void {
    if (this.abort) {
      // 状态行先落到「取消中」：abort 传导到 loop 收尾可能有可见延迟（正在跑的工具要
      // 等它自己退出），这段窗口里不能还挂着「Running Bash…」。
      this.setActivity(WorkingLabel.cancelling);
      this.abort.abort();
      this.addNotice(
        this.turnOutputStarted ? 'Interrupted — output stopped.' : 'Cancelled before the model replied.',
        'warn',
      );
      return;
    }
    if (this.ui.hasOverlay()) {
      this.ui.hideOverlay();
    }
  }

  // ------------------------------------------------------------------ 事件投影

  private readonly listener: AgentListener = (event) => {
    switch (event.type) {
      case 'text': {
        this.turnOutputStarted = true;
        this.setActivity(WorkingLabel.responding);
        const assistant = this.ensureAssistant();
        assistant.appendText(event.text);
        break;
      }
      case 'thinking_start': {
        this.thinkingId = event.id;
        this.thinkingBuffer = '';
        this.thinkingStartedAt = Date.now();
        this.setActivity(WorkingLabel.thinking);
        // 思考链并入工具分组：它和同一步的工具调用共享折叠语义（grok-build 的
        //「run claims finished thoughts」）。这一步先开组，稍后的 tool_start 会复用同一个组。
        this.thinkingGroup = this.ensureToolGroup();
        this.thinkingGroup.setThinking('', true);
        break;
      }
      case 'thinking_delta': {
        if (event.id === this.thinkingId) {
          this.turnOutputStarted = true;
          this.setActivity(WorkingLabel.thinking);
          this.thinkingBuffer += event.text;
          this.thinkingGroup?.setThinking(this.thinkingBuffer, true);
        }
        break;
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
        }
        break;
      }
      case 'tool_start': {
        // 工具活动切断当前助手段：下一个 thinking/text 事件经 ensureAssistant 在工具组
        // 下方新起组件。否则整轮文字都挤进轮首那个组件里，最终总结会排在工具汇总之上，
        // 变成「全部回答在上、工具组沉底」——时间线要按真实顺序交错（grok-build 语义）。
        this.streamingAssistant?.setStreaming(false);
        this.streamingAssistant = undefined;
        const tool = new ToolExecutionComponent(event.name, event.id, event.args, this.ui);
        tool.markExecutionStarted();
        this.ensureToolGroup().addTool(tool);
        this.pendingTools.set(event.id, tool);
        this.setActivity(WorkingLabel.running(toolDisplayName(event.name)));
        // subagent 的实时进度由转录内任务块承担，不进底部「正在跑」区。
        if (event.name !== 'subagent') this.addPendingToolLine(event.id, event.name, event.args);
        break;
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
        break;
      }
      case 'usage': {
        this.applyUsage(event as unknown as Record<string, unknown>);
        break;
      }
      case 'status': {
        this.addNotice(event.text, 'dim');
        break;
      }
      case 'error': {
        this.addNotice(event.text, 'error');
        break;
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
        break;
      }
      case 'subagent_end': {
        this.subagentDepth = Math.max(0, this.subagentDepth - 1);
        if (!this.finishSubagentLine(event.id, event.ok, event.durationMs, event.summary, event.tokens)) {
          const label = event.ok
            ? `subagent · done in ${(event.durationMs / 1000).toFixed(1)}s`
            : `subagent · FAILED: ${event.summary.slice(0, 200)}`;
          this.addNotice(label, event.ok ? 'dim' : 'error');
        }
        break;
      }
      case 'subagent_event': {
        this.onSubagentEvent(event.id, event.event);
        break;
      }
      case 'done': {
        this.finalizeStreaming();
        break;
      }
      default:
        break;
    }
    this.ui.requestRender();
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
      return;
    }
    if (event.type === 'usage') {
      entry.live?.addTokens(event.promptTokens + event.completionTokens);
      return;
    }
    const activity = subagentActivity(event);
    if (activity !== undefined) entry.live?.setActivity(activity, event.type === 'error');
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

  /** 待办区显示一行「正在跑的工具」；按 toolCallId 记账，tool_end 时精确移除。 */
  private addPendingToolLine(id: string, name: string, args: Record<string, unknown>): void {
    const detail = typeof args.command === 'string' ? args.command : (typeof args.path === 'string' ? args.path : '');
    const text = new Text(theme.fg('muted', `  ${name}${detail ? ` ${detail}` : ''}`), 0, 0);
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
    // 状态行常驻输入框上方（grok-build 的 turn status 行位置），左对齐：空闲时是
    // 两行占位，工作时换成「转圈 + 阶段文案」。两种形态同为两行，切换时高度不变。
    this.statusContainer.clear();
    this.statusContainer.addChild(indicator ?? this.idleStatus);
  }

  private currentIndicator?: WorkingStatusIndicator;
  /** 当前状态行文案；措辞未变时不重复 setMessage，流式增量不会每帧重设同一句。 */
  private activityLabel?: string;

  /** 切换状态行文案。只在轮次进行中有意义（空闲时没有指示器可改）。 */
  private setActivity(message: string): void {
    if (this.activityLabel === message) return;
    this.activityLabel = message;
    this.currentIndicator?.setMessage(message);
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
      mcpServerCount: this.deps.mcpServerCount,
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
    const detail = request.command ?? request.path ?? '(no detail)';
    const body = note ? `${detail}\n\n${theme.fg('warning', note)}` : detail;
    const choice = await showSelectDialog(this.ui, {
      title: `Approve ${request.tool}?`,
      bodyText: body,
      items: [
        { value: 'allow', label: 'Allow once' },
        { value: 'always', label: `Always allow ${request.tool} this session` },
        { value: 'deny', label: 'Deny' },
      ],
      maxVisible: 3,
    });
    if (choice === 'always') {
      this.approver.allowForSession(request.tool);
      return true;
    }
    return choice === 'allow';
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
    const selected = await this.editor.showInlineMenu({ title: 'Commands', items, maxVisible: 14 });
    if (selected) await this.handleCommand(`/${selected.value}`);
  }

  private async handleCommand(input: string): Promise<void> {
    const [rawName, ...rest] = input.slice(1).split(/\s+/);
    const name = rawName.toLowerCase();
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
      case 'sessions':
        await this.commandSessions(argument);
        break;
      case 'status':
        await this.commandStatus();
        break;
      case 'goal':
        await this.commandGoal(argument);
        break;
      case 'model':
        await this.commandModel(argument);
        break;
      case 'effort':
        await this.commandEffort(argument);
        break;
      case 'approval':
        await this.commandApproval(argument);
        break;
      case 'todo':
        await this.commandTodo();
        break;
      case 'jobs':
        await this.commandJobs();
        break;
      case 'export':
        await this.commandExport(argument);
        break;
      case 'clear':
        this.commandClear();
        break;
      case 'quit':
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
    lines.push('');
    lines.push('## Key bindings');
    lines.push('- `Esc` — cancel a turn that has not replied yet, interrupt one that is streaming, or close a dialog');
    lines.push('- `Ctrl+C` — interrupt the running turn; with no turn running, clear the input, and press it twice to quit');
    lines.push('- `Ctrl+D` — quit when the input is empty');
    lines.push('- `Ctrl+O` — expand or collapse tool output');
    lines.push('- `Ctrl+P` — open the command palette');
    lines.push('- `/` — slash-command autocomplete in the editor');
    await showMessageDialog(this.ui, { title: 'Help', text: lines.join('\n') });
  }

  private async commandNewSession(): Promise<void> {
    const confirmed = await showConfirmDialog(this.ui, {
      title: 'Start a new session?',
      message: 'The current conversation stays on disk and can be resumed later.',
      confirmLabel: 'New session',
      cancelLabel: 'Cancel',
    });
    if (!confirmed) return;
    this.session = createSession(this.deps.sessionDir, this.deps.workspaceRoot);
    this.clearChat();
    this.goal = undefined;
    this.lastFailure = undefined;
    this.refreshCounters();
    this.addNotice(`Started session ${this.session.id}`, 'success');
  }

  /** `/sessions [id]`：带 id 前缀匹配直接切换，不带 id 打开选择器。 */
  private async commandSessions(id: string): Promise<void> {
    if (id !== '') {
      const sessions = await listSessions(this.deps.sessionDir);
      const match = sessions.find((info) => info.id === id || info.id.startsWith(id));
      if (!match) {
        this.addNotice(`No session matching "${id}".`, 'warn');
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
      description: `${new Date(info.mtimeMs).toISOString().replace('T', ' ').slice(0, 16)} · ${info.messages} msgs · ${info.preview}`,
    }));
    const selected = await this.editor.showInlineMenu({ title: 'Sessions', items, maxVisible: 12 });
    if (!selected || selected.value === this.session.id) return;
    this.switchSession(selected.value);
  }

  /** 切到指定会话并把状态从日志回放出来；调用方负责过滤「已在该会话」。 */
  private switchSession(id: string): void {
    this.session = new JsonlSession(this.deps.sessionDir, id);
    setCurrentSession(this.deps.sessionDir, id, this.deps.workspaceRoot);
    this.clearChat();
    this.restoreSession();
    this.refreshCounters();
    this.addNotice(`Switched to session ${id}`, 'success');
  }

  private async commandStatus(): Promise<void> {
    const lines = [
      `- **session**: \`${this.session.id}\``,
      `- **workspace**: \`${this.deps.workspaceRoot}\``,
      `- **model**: \`${this.model}\``,
      `- **effort**: \`${this.effort ?? '(default)'}\``,
      `- **approval**: \`${this.approval}\``,
      `- **sandbox**: \`${this.deps.sandbox.status.mode}\``,
      `- **context window**: \`${this.contextWindow}\``,
      `- **goal**: \`${this.goal ?? '(none)'}\``,
      `- **tokens**: ↑${this.usage.promptTokens} ↓${this.usage.completionTokens} R${this.usage.cachedTokens}`,
    ];
    await showMessageDialog(this.ui, { title: 'Status', text: lines.join('\n') });
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
    const cache = this.deps.modelCachePath ? readModelCache(this.deps.baseUrl, this.deps.modelCachePath) : undefined;
    let models: readonly string[] = cache?.models ?? [];
    if (models.length === 0) {
      this.addNotice('Fetching model list…', 'dim');
      try {
        models = await this.deps.fetchModels();
        if (this.deps.modelCachePath && models.length > 0) {
          writeModelCache(this.deps.baseUrl, models, this.deps.modelCachePath);
        }
      } catch (error) {
        this.addNotice(`Failed to fetch models: ${message(error)}`, 'error');
        return;
      }
    }
    if (models.length === 0) {
      this.addNotice('No models available.', 'warn');
      return;
    }
    const items: SelectItem[] = models.map((id) => ({
      value: id,
      label: id,
      description: id === this.model ? 'current' : undefined,
    }));
    const selected = await this.editor.showInlineMenu({ title: 'Model', items, maxVisible: 14 });
    if (!selected || selected.value === this.model) return;
    this.applyModel(selected.value);
  }

  /** 应用模型选择：重建 client、记事件、写回配置。 */
  private applyModel(model: string): void {
    this.model = model;
    this.client = this.buildClient();
    this.session.appendEvent(
      'model_selection',
      sessionEventData.modelSelection({ model, contextWindow: this.contextWindow, maxTokens: this.maxTokens }),
    );
    const error = this.writeConfig({ model });
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
    const items: SelectItem[] = REASONING_EFFORTS.map((effort) => ({
      value: effort,
      label: effort,
      description: effort === this.effort ? 'current' : undefined,
    }));
    const selected = await this.editor.showInlineMenu({ title: 'Reasoning effort', items, maxVisible: 6 });
    if (!selected) return;
    this.applyEffort(selected.value as ReasoningEffort);
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

  private async commandApproval(argument = ''): Promise<void> {
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
    const selected = await this.editor.showInlineMenu({ title: 'Approval mode', items, maxVisible: 3 });
    if (!selected) return;
    this.applyApproval(selected.value as ApprovalMode);
  }

  private applyApproval(mode: ApprovalMode): void {
    this.approval = mode;
    this.applyApprovalBorder();
    const error = this.writeConfig({ approval: mode });
    this.addNotice(
      error ? `Approval mode set to ${mode} (config write failed: ${error})` : `Approval mode set to ${mode}`,
      error ? 'warn' : 'success',
    );
  }

  /**
   * 审批模式映射到输入框边框颜色，一眼可辨当前风险等级：
   * ask = 中性灰（默认），auto = 黄（模型代审，半自动），yolo = 红（全部放行，危险）。
   */
  private applyApprovalBorder(): void {
    const color = this.approval === 'yolo' ? 'error' : this.approval === 'auto' ? 'warning' : 'borderMuted';
    this.editor.borderColor = (text: string) => theme.fg(color, text);
  }

  private async commandTodo(): Promise<void> {
    const items = this.deps.todos.list();
    if (items.length === 0) {
      this.addNotice('To-do list is empty.', 'dim');
      return;
    }
    const text = items
      .map((item) => `- [${item.status === 'completed' ? 'x' : ' '}] ${item.content}`)
      .join('\n');
    await showMessageDialog(this.ui, { title: 'To-do', text });
  }

  private async commandJobs(): Promise<void> {
    const jobs = this.deps.jobs.list();
    if (jobs.length === 0) {
      this.addNotice('No background jobs.', 'dim');
      return;
    }
    const text = jobs
      .map((job) => `- \`${job.id}\` ${job.status} · ${job.result ?? job.command ?? ''}`)
      .join('\n');
    await showMessageDialog(this.ui, { title: 'Jobs', text });
  }

  private async commandExport(argument: string): Promise<void> {
    const format = argument === 'json' ? 'json' : 'md';
    const content = format === 'json' ? exportJson(this.session) : exportMarkdown(this.session);
    await showMessageDialog(this.ui, {
      title: `Export (${format})`,
      text: `\`\`\`\n${content.slice(0, 20000)}\n\`\`\``,
      hint: 'Esc close',
      width: '90%',
    });
  }

  private commandClear(): void {
    this.clearChat();
    this.addNotice('Conversation view cleared.', 'dim');
  }

  private clearChat(): void {
    this.transcriptView?.setPinY(undefined);
    this.chatContainer.clear();
    this.toolGroups.length = 0;
    this.activeToolGroup = undefined;
    this.pendingTools.clear();
    this.streamingAssistant = undefined;
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
      api: this.deps.api,
      effort: this.effort,
      maxTokens: this.maxTokens,
    });
  }
}
