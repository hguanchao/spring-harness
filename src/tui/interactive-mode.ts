/**
 * 交互模式的装配与调度。
 *
 * 文档容器（header + chat）放进 ScrollView，固定在底部的 dock 由
 *   「pending / status / editor / footer」垂直堆叠：
 *   - 全屏（替代屏幕）模式用 VStack 约束布局，主屏模式则按顺序 addChild 成一份纵向文档；
 *   - agent 事件 → 对话块（用户块 / 助手块 / 工具块 / 状态行）；
 *   - 审批、提问通过浮层对话框完成，浮层用 Promise 把结果回给等待中的 agent 调用。
 *
 * 事件投影走 runTurn + AgentListener，会话回放和命令集按 sph 的语义实现。
 *
 * 本文件只保留「装配 + 轮次调度 + 事件分派」这条主干；按职责拆出的协作模块：
 *   - commands.ts          —— 斜杠命令注册表（/help、面板、补全的单一数据源）
 *   - steer-bar.ts         —— 挂起条（运行中输入队列的渲染与鼠标交互）
 *   - transcript.ts        —— 事件 → 转录的投影（助手块/思考链/工具组/子代理 dock）
 *   - session-replay.ts    —— 会话记录 → 界面的回放
 *   - mcp-commands.ts      —— /mcps 命令域
 *   - session-commands.ts  —— /history /new /resume /export 命令域
 *   - settings-commands.ts —— /model /provider /effort /permission 命令域
 * 协作模块经窄接口（各 *Host）回调宿主，宿主的会话/模型/审批状态不外泄。
 */

import { basename, join } from 'node:path';
import type { AgentListener } from '../agent/events.js';
import { collectFileMentions } from '../agent/attachments.js';
import { loadCompaction, projectContext } from '../agent/compact.js';
import { loadUserTheme } from './theme/theme.js';
import { sphModelsPath, sphThemePath } from '../home.js';

import { createSteeringInbox, STEERING_QUEUE_LIMIT, type SteeringInbox } from '../runtime/jobs.js';
import { jobNotificationText } from '../runtime/jobs.js';
import { runTurn } from '../agent/loop.js';
import { TouchMemory } from '../agent/memory.js';
import { buildSystemPrompt } from '../agent/prompt.js';
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
import { HeadlessApprover, type ApprovalMode, type ApprovalRequest, type Approver } from '../permission/policy.js';
import { createGrantStore } from '../permission/store.js';
import { updateConfigFile } from '../config/save.js';
import { upsertModelApi, type ProviderDeclaration } from '../config/registry.js';
import type { ApiProtocol } from '../config/load.js';
import type { LlmClient, ReasoningEffort, TokenUsage } from '../llm/openai.js';
import { SpillStore } from '../runtime/spill.js';
import { sessionEventData, type SessionFailure } from '../session/fold.js';
import {
  jsonlSessionFactory,
  JsonlSession,
  setCurrentSession,
} from '../session/store.js';
import { defaultTools } from '../tools/index.js';
import {
  BLOCK_GAP,
  CombinedAutocompleteProvider,
  Container,
  findFdBinary,
  isKeyRelease,
  isViewportTUI,
  type SelectItem,
  type SlashCommand,
  Spacer,
  Text,
  type TUI,
  TuiAltScreen,
  ProcessTerminal,
  VStack,
  ScrollView,
  formatKeyText,
} from './screen/index.js';
import { APP_KEYBINDINGS, matchesAppKey, type AppKeybindingDefinition } from './app-keybindings.js';
import { InteractiveApprover, type ApprovalUi } from './permission.js';
import { showInputDialog, showMessageDialog, showSelectDialog } from './dialogs.js';
import { renderPluginsReport, renderSkillsReport } from './reports.js';
import { readGitBranch } from './git.js';
import { IdleStatus, WorkingLabel, WorkingStatusIndicator, DynamicBorder, formatWorkingWarning, keyHint, workingWarningKey } from './components/interaction.js';
import { clearHoverHighlight } from './components/hover-highlight.js';
import { toolDisplayName, summarizeArgs } from './components/tool-execution.js';
import { CustomEditor } from './components/custom-editor.js';
import { FooterComponent, type FooterData } from './components/footer.js';
import { HeaderComponent } from './components/header.js';
import { UserMessageComponent } from './components/user-message.js';
import { userMessageBubbleY } from './components/sticky-user-message.js';
import { RecapMessageComponent } from './components/recap.js';
import { generateSessionTitle, TITLE_SOURCE_SAMPLE_CHARS } from './session-title.js';
import { getEditorTheme, getMarkdownTheme, theme } from './theme/theme.js';
import { errorMessage, flattenWhitespace } from '../util.js';
import { readVersion } from '../version.js';
import { COMMANDS, COMMAND_ALIASES, COMMAND_NAMES, primaryColumnWidthFor } from './commands.js';
import { SteerBar, type SteerBarHost } from './steer-bar.js';
import { TranscriptProjection, type TranscriptHost } from './transcript.js';
import { restoreSessionInto, type ReplayHost } from './session-replay.js';
import { commandMcps } from './mcp-commands.js';
import { commandHistory, commandNewSession, commandResume, commandExport, type SessionCommandHost } from './session-commands.js';
import { commandModel, commandProvider, commandEffort, commandPermission, cycleApprovalMode, type SettingsCommandHost } from './settings-commands.js';
import type { TuiDeps } from './deps.js';

/** 命令模块和测试从这里拿 TuiDeps。进程入口不再把屏幕类型一起导出。 */
export type { TuiDeps } from './deps.js';

function message(error: unknown): string {
  return errorMessage(error);
}

/** 交互模式入口。 */
export async function runTui(deps: TuiDeps): Promise<void> {
  loadUserTheme(sphThemePath());
  const mode = new InteractiveMode(deps);
  await mode.run();
}

class InteractiveMode implements ApprovalUi, SteerBarHost, TranscriptHost, ReplayHost, SessionCommandHost, SettingsCommandHost {
  public readonly deps: TuiDeps;
  public readonly ui: TUI;
  public readonly editor: CustomEditor;

  private readonly headerContainer = new Container();
  public readonly chatContainer = new VStack();
  private readonly documentContainer = new VStack();
  public readonly pendingContainer = new Container();
  /** 挂起条专属容器：工作状态行之下、输入框之上——排队的话紧贴着要发送的位置。 */
  private readonly steersContainer = new Container();
  public readonly subagentContainer = new Container();
  public readonly subagentHeader = new Text('', 0, 0);
  private readonly statusContainer = new Container();
  private readonly editorContainer = new Container();
  private readonly footerContainer = new Container();
  private transcriptView: ScrollView | undefined;
  private readonly idleStatus = new IdleStatus(() => this.ui?.requestRender());
  private readonly footer: FooterComponent;
  private readonly header: HeaderComponent;

  public session: JsonlSession;
  private client: LlmClient;
  private readonly turnInbox: SteeringInbox = createSteeringInbox();
  /**
   * 挂起条（steer-bar.ts）：运行中输入队列的渲染与鼠标交互。
   * 队列空时零占用；行内操作（悬停按钮/单击选中/取回编辑）都收在组件里。
   */
  private readonly steerBar: SteerBar;
  /** 事件 → 转录的投影（transcript.ts）：助手块/思考链/工具组/子代理 dock 的状态都归它。 */
  public readonly projection: TranscriptProjection;
  private followUps: string[] = [];
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
  /** 终端 tab 标题的项目段：工作区目录名，一次进程内不变。 */
  private tabProject = '';
  /** LLM 生成的会话标题；tab 空闲段用它，落会话事件，resume 回放不重新生成。 */
  private sessionTitle?: string;
  /** 标题生成一次性开关：失败也重试的话，坏会话每轮都要白烧一次调用。 */
  private sessionTitleAttempted = false;
  /** 首轮标题素材：用户 prompt 与助手正文采样，轮次收尾后交给生成器。 */
  private titlePrompt?: string;
  private titleDraft?: string;
  private quitting = false;
  private abort?: AbortController;
  private quitResolve?: () => void;
  private lastSigintAt = 0;
  private lastSigintTimer?: NodeJS.Timeout;
  /** 本轮可 rewind 的用户原文；后台唤醒注入的通知不能塞回输入框。 */
  private inFlightPrompt?: string;
  /** 取消时把原文放回输入框（等 abort 收尾后再做，避免和 thinking_start 抢）。 */
  private pendingRewind?: string;
  /**
   * 立即发送的待投内容：挂起队列在 turn 运行中触发「现在就发」时，先中断当前轮，
   * 轮次收尾（finally）里以这段合并文本立即开新一轮。仅在 sendQueuedNow 设置。
   */
  private sendAfterInterrupt?: string;
  /** 会话的持久化深度下限（resume 恢复），本轮 runTurn 从这里起步。 */
  private sessionDepth = 0;

  private usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
  private contextTokens?: number;

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
    // 划词高亮走主题实心块 + 对比字色，跟终端原生拖选同观感；ansi 模式 selectionStyle 为 undefined，退回反显。
    this.ui =
      deps.ui ??
      new TuiAltScreen(deps.terminal ?? new ProcessTerminal(), false, deps.workspaceRoot, {
        selectionStyle: theme.selectionStyle(),
        onCopyFeedback: (message) => this.showCopyHint(message),
      });
    this.editor = new CustomEditor(this.ui, getEditorTheme(), {
      paddingX: 1,
      autocompleteMaxVisible: 8,
    });
    this.applyEditorBorder();

    // tab 标题带目录名：多开几个 tab 时能分清哪个会话连的是哪个工作区。
    this.tabProject = basename(deps.workspaceRoot);

    // 挂起条与投影依赖的宿主回调此刻都已就位；挂起条构造即入容器占位，队列空时零占用。
    this.steerBar = new SteerBar(this.turnInbox, this);
    this.projection = new TranscriptProjection(this);
    this.steersContainer.addChild(this.steerBar.component);

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

  /**
   * 终端 tab 标题：空闲 `<会话标题> | 项目`（还没有标题时退回 `sph`），工作态
   * `● <当前活动> | 项目`。活动文本随 setActivity 实时跟进，多 tab 下不用切回去
   * 就知道哪个在干活、干到哪一步。判定用 activityLabel 而非 running：/compact
   * 折叠上下文不在轮次里，但也算工作态。forceIdle 给退出路径用：中断收尾是异步的，
   * 退出时活动词还没清掉，不能留下 ●。
   */
  private refreshTabTitle(forceIdle = false): void {
    const base = this.sessionTitle ?? 'sph';
    const status = !forceIdle && this.activityLabel !== undefined
      ? `● ${this.activityLabel}`
      : base;
    this.ui.terminal.setTitle(`${status} | ${this.tabProject}`);
  }

  /** 首轮交换结束后生成会话标题（异步、不阻塞）：成功则落事件并刷新 tab，失败静默。 */
  private maybeGenerateSessionTitle(): void {
    const prompt = this.titlePrompt;
    if (prompt === undefined) return;
    this.titlePrompt = undefined;
    const draft = this.titleDraft ?? '';
    this.titleDraft = undefined;
    // 首轮请求就失败（断网/403）不算尝试：标题生成不该抢在链路可用性之前烧机会。
    if (!this.projection.modelResponded) return;
    this.sessionTitleAttempted = true;
    void generateSessionTitle(this.client, prompt, draft, {
      // 主代理同款工具集：免费档网关按请求形态放行，不带会被当外部 API 滥用拒掉。
      tools: (this.deps.tools ?? defaultTools).schemas(),
      onUsage: (usage) => this.recordAuxUsage(usage, 'title'),
    }).then((title) => {
      if (title === undefined) return;
      this.sessionTitle = title;
      this.session.appendEvent('title', { title });
      if (!this.quitting) this.refreshTabTitle();
    });
  }

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
    this.refreshTabTitle();
    this.ui.requestRender();
    this.startRecapWatch();

    await new Promise<void>((resolve) => {
      this.quitResolve = resolve;
    });

    // 退回主屏幕后递一条会话恢复命令：想接着聊时不用去翻 sessions 目录。
    // 空会话（打开即退）不打印，避免噪音；headless 路径不加（一次性任务）。
    if (this.session.readAll().length > 0) {
      process.stdout.write(`sph --resume ${this.session.id}\n`);
    }
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
    this.editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(slashCommands, this.deps.workspaceRoot, findFdBinary()),
    );
    this.editor.onSubmit = (text) => {
      void this.handleSubmit(text);
    };
    // 挂起队列非空时 ↑ 把队列全部搬回编辑器：删掉不要的行即取消，
    // Enter 重新挂起。全量搬回而不是逐条——一条规则讲清楚，没有歧义中间态。
    // 悬停离开检测：任何鼠标移动先清各类悬停高亮（挂起条浅底/提示/按钮、工具行/汇总行浅底）；
    // 若光标仍悬在原目标上，同帧的组件分发会重新点亮——监听器先于分发执行，一清一亮。
    this.ui.onMouseMotion = () => {
      let changed = clearHoverHighlight();
      if (this.steerBar.clearHover()) changed = true;
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
      if (matchesAppKey(data, 'app.approval.cycle')) {
        cycleApprovalMode(this);
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

  /** 恢复会话：记录回放、输入历史回填（实现在 session-replay.ts，状态落位回宿主）。 */
  private restoreSession(): void {
    restoreSessionInto(this);
  }

  /** 回放折叠出的跨轮次状态落位（ReplayHost）。 */
  applyFoldedState(state: {
    goal?: string;
    lastFailure?: SessionFailure;
    planMode: boolean;
    lastRecapMainTurn: number;
    depth: number;
  }): void {
    this.goal = state.goal;
    this.lastFailure = state.lastFailure;
    this.plan.active = state.planMode;
    this.lastRecapMainTurn = state.lastRecapMainTurn;
    // 持久化深度下限：resume 出的子代理会话不能伪装成顶层继续派生（ds 的 delegationDepth 语义）。
    this.sessionDepth = state.depth;
  }

  /** 回放到的 model_selection 事件落位：本进程后续请求按它发（ReplayHost）。 */
  applyReplayedModel(model: string, contextWindow?: number, maxTokens?: number): void {
    this.model = model;
    if (contextWindow !== undefined) this.contextWindow = contextWindow;
    if (maxTokens !== undefined) this.maxTokens = maxTokens;
  }

  /** 回放到的会话标题落位（ReplayHost）。 */
  applySessionTitle(title: string): void {
    this.sessionTitle = title;
    this.sessionTitleAttempted = true;
  }

  /** 把最新一条用户消息钉在转录顶：回复还没超出一屏时滚到该条，超出后跟底并由 overlay 吸顶。 */
  public pinLatestUserMessage(): void {
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

  // ------------------------------------------------------------------ 挂起条的宿主回调（SteerBarHost）

  public requestRender(): void {
    this.ui.requestRender();
  }

  /** 焦点交回输入框（挂起条取回编辑后）。 */
  public focusEditor(): void {
    this.ui.setFocus(this.editor);
  }

  /** 当前是否存在可中断的轮次（挂起条 [Send now] 的前置检查）。 */
  public canInterrupt(): boolean {
    return this.abort !== undefined;
  }

  /**
   * 挂起条 [Send now] 的落地：该条作为下一轮 prompt，中断当前轮；
   * 轮次收尾（finally）里按 sendAfterInterrupt 接续开新一轮。
   */
  public sendNow(text: string): void {
    this.sendAfterInterrupt = text;
    this.setActivity(WorkingLabel.cancelling);
    this.abort?.abort();
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

    if (text.startsWith('/')) {
      await this.handleCommand(text);
      return;
    }
    this.editor.addToHistory(text);
    if (this.running) {
      // 队列满时拒绝而不是挤掉最旧：静默丢用户的输入是最差的失败模式。
      if (this.turnInbox.full()) {
        this.addNotice(
          `Steering queue is full (${STEERING_QUEUE_LIMIT}) — press Enter to send now, or ↑ to edit the queue.`,
          'warn',
        );
        return;
      }
      if (this.steerBar.editFrozen) {
        // 双击取回后重新挂起：插回原排序位而不是队尾（队列已被 drain 时越界收敛为追加）。
        // 提交即解冻：编辑期间轮次若已收尾，这里补开新轮，让编辑后的消息第一个发出。
        const head = this.steerBar.insertEdit(text);
        this.ui.requestRender();
        if (!this.running) {
          if (head !== undefined) {
            this.steerBar.dropFirst();
            this.steerBar.resetState();
            void this.executeTurn(head, true);
          }
        }
        return;
      } else {
        this.steerBar.push(text);
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
    this.projection.beginTurn();
    // 首轮（且标题还没生成过）记下素材源头；后续轮次不覆盖，素材在 'text' 事件里累积。
    if (!this.sessionTitleAttempted) {
      this.titlePrompt = prompt;
      this.titleDraft = '';
    }
    // @ 提及在提交侧展开：上屏与标题都用原文；附件随轮次选项进 loop——存储保持原文，
    // 投影层发给模型时才把文件内容拼进去。
    const mentions = collectFileMentions(prompt, this.deps.workspaceRoot);
    this.inFlightPrompt = rewindable ? prompt : undefined;
    this.pendingRewind = undefined;
    // 发出去之后输入框失焦：否则边框一直是聚焦色，像还在打字。
    this.ui.setFocus(null);
    const indicator = new WorkingStatusIndicator(this.ui, WorkingLabel.working);
    if (this.contextTokens !== undefined) indicator.setTokens(this.contextTokens);
    this.setStatusIndicator(indicator);
    // 指示器已带初始文案，这里只是把 activityLabel 记上，后续 setActivity 才知道该不该重设。
    this.setActivity(WorkingLabel.working);

    // 失败标记：非中断的异常收尾。模型零输出就失败的轮次不算「正常收尾」——否则端点
    // 挂掉（如 403 区域限制）时轮次秒败，收尾自动投递会把挂起队列一条条烧成同一个错误。
    let turnFailed = false;
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
        services: this.deps.pluginServices,
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
        ...(mentions.attachments.length > 0 ? { attachments: mentions.attachments } : {}),
        ...(mentions.images.length > 0 ? { userImages: mentions.images } : {}),
        ...(this.deps.spillRoot === undefined
          ? {}
          : { spill: new SpillStore(join(this.deps.spillRoot, this.session.id), this.deps.spillThreshold) }),
        ...(this.subagentApprover === undefined ? {} : { subagentApprover: this.subagentApprover }),
      });
    } catch (error) {
      // 中断提示已由 handleInterrupt 即时给出，这里不再重复一条。
      if (!controller.signal.aborted) {
        this.addNotice(message(error), 'error');
        turnFailed = true;
      }
    } finally {
      this.projection.finalizeStreaming();
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
        const stranded = this.steerBar.drainAll();
        this.steerBar.resetState();
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
      // 扣住条件：失败且模型零输出。有部分输出说明任务推进过，挂起消息作为下一步
      // 指令照常接管；零输出意味着这一轮什么都没发生，投递只是把队列烧进同一个错误。
      const holdQueue = turnFailed && !this.projection.modelResponded;
      const normalEnd = !controller.signal.aborted && rewind === undefined && !holdQueue;
      const steerNext = normalEnd && !this.steerBar.editFrozen ? this.steerBar.nextQueued : undefined;
      if (holdQueue) {
        const held = this.steerBar.queuedCount;
        if (held > 0) {
          this.addNotice(
            `Turn failed — ${held} queued message${held === 1 ? '' : 's'} kept. Enter sends ${held === 1 ? 'it' : 'them'} now.`,
            'warn',
          );
        }
      }
      const follow = normalEnd && steerNext === undefined ? this.followUps.shift() : undefined;
      // 空闲计时从轮次收尾算起：一轮跑两分钟不该把那两分钟算成「用户离开」。
      this.lastActivityAt = Date.now();
      this.setStatusIndicator(undefined);
      // 指示器清掉后 activityLabel 已归位，此刻刷新才能落回空闲标题。
      this.refreshTabTitle();
      // 标题只在首轮交换后生成一次；这里的素材已在上面清点完毕。
      this.maybeGenerateSessionTitle();
      this.projection.clearPendingTools();
      // 轮次结束但后台子代理仍在跑（foreground 的 end 事件在工具返回前就已到）：
      // 提醒一句，避免用户以为总结就是全部结论。
      if (this.projection.liveSubagentCount > 0) {
        const n = this.projection.liveSubagentCount;
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
        // biome-ignore lint/correctness/noUnsafeFinally: 轮次收尾接续开新轮是刻意的队列语义，return 用于阻止后续分支
        return;
      }
      if (!this.running && steerNext !== undefined) {
        this.steerBar.dropFirst();
        this.steerBar.resetState();
        void this.executeTurn(steerNext, true);
        // biome-ignore lint/correctness/noUnsafeFinally: 同上——收尾后立即投递队首挂起消息
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
    if (this.steerBar.editFrozen) return;
    const queued = this.steerBar.drainAll();
    if (queued.length === 0) return;
    this.steerBar.resetState();
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
      const rewind = !this.projection.modelResponded && this.inFlightPrompt !== undefined && composerEmpty;
      this.pendingRewind = rewind ? this.inFlightPrompt : undefined;
      this.abort.abort();
      this.addNotice(
        rewind
          ? 'Cancelled — prompt restored to the input.'
          : this.projection.modelResponded
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
  public paint(kind: 'transcript' | 'dock'): void {
    if (kind === 'dock' && isViewportTUI(this.ui)) this.ui.requestViewportRender();
    else this.ui.requestRender();
  }

  /**
   * 事件分派：agent 事件 → 转录投影（transcript.ts）+ 宿主自有状态（活动词、标题采样、
   * 用量、审批边框）。渲染细节全部下沉到投影，这里只回答「事件归谁处理」。
   */
  private readonly listener: AgentListener = (event) => {
    switch (event.type) {
      case 'stream_retry': {
        this.projection.restartThinking();
        this.projection.dropStreamingAssistant();
        // 采样里的半截正文也在被丢弃之列，别让它混进标题素材。
        if (this.titleDraft !== undefined) this.titleDraft = '';
        this.paint('transcript');
        return;
      }
      case 'text': {
        this.setActivity(WorkingLabel.responding);
        this.projection.appendAssistantText(event.text);
        // 首轮正文顺手采样：会话标题的素材（超长回复截断，不追加成本）。
        if (this.titleDraft !== undefined && this.titleDraft.length < TITLE_SOURCE_SAMPLE_CHARS) {
          this.titleDraft += event.text;
        }
        this.paint('transcript');
        return;
      }
      case 'thinking_start': {
        // 不在 start 切 Thinking…：无 reasoning 的工具轮次永远等不到 delta，状态行会假死。
        // 压缩刚结束时要把 Folding context… 收回去，否则会一直挂到第一条 delta。
        if (this.activityLabel === WorkingLabel.compacting) this.setActivity(WorkingLabel.working);
        this.projection.beginThinking(event.id);
        this.paint('transcript');
        return;
      }
      case 'thinking_delta': {
        const active = this.projection.appendThinking(event.id, event.text);
        if (active) this.setActivity(WorkingLabel.thinking);
        this.paint('transcript');
        return;
      }
      case 'thinking_end': {
        this.projection.endThinking(event.id, event.content);
        // 没 reasoning 的工具轮次不会再来 thinking_delta；状态行若还停在 Thinking…，
        // 这里立刻离开，别等下一步工具/正文。
        if (this.activityLabel === WorkingLabel.thinking) this.setActivity(WorkingLabel.working);
        this.paint('transcript');
        return;
      }
      case 'tool_start': {
        this.projection.startTool(event.id, event.name, event.args);
        this.setActivity(WorkingLabel.running(toolDisplayName(event.name), summarizeArgs(event.name, event.args)));
        this.paint('transcript');
        return;
      }
      case 'tool_end': {
        this.projection.endTool(event.id, event.content, event.ok);
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
        const started = this.projection.startSubagent({
          id: event.id,
          toolCallId: event.toolCallId,
          childType: event.childType,
          background: event.mode === 'background',
          description: event.description,
        });
        if (!started) {
          this.addNotice(
            `subagent · ${event.description} (${event.childType}${event.mode === 'background' ? ', background' : ''})`,
            'dim',
          );
        }
        this.paint('transcript');
        return;
      }
      case 'subagent_end': {
        if (!this.projection.finishSubagent(event.id, event.ok, event.durationMs, event.summary, event.tokens)) {
          const label = event.ok
            ? `subagent · done in ${(event.durationMs / 1000).toFixed(1)}s`
            : `subagent · FAILED: ${event.summary.slice(0, 200)}`;
          this.addNotice(label, event.ok ? 'dim' : 'error');
        }
        this.paint('transcript');
        return;
      }
      case 'subagent_event': {
        this.projection.onSubagentEvent(event.id, event.event);
        return;
      }
      case 'done': {
        this.projection.finalizeStreaming();
        this.paint('transcript');
        return;
      }
      default:
        break;
    }
  };

  // ------------------------------------------------------------------ 用量

  public applyUsage(data: Record<string, unknown>): void {
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

  public addNotice(text: string, level: 'dim' | 'warn' | 'error' | 'success' = 'dim'): void {
    this.projection.breakToolGroup();
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
    // 状态行换词的同时把当前活动同步进 tab 标题；重复文案在上面的去重挡掉，不会刷屏。
    this.refreshTabTitle();
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
    // 警告词绕过 setActivity 直写，tab 标题这里手动跟一次。
    this.refreshTabTitle();
    this.currentIndicator.setShimmer(false);
    this.currentIndicator.setMessageColor((content) => theme.fg('warning', content));
    this.currentIndicator.setMessage(label);
    return true;
  }

  private toggleToolExpansion(): void {
    this.projection.toggleToolExpansion();
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
    // 运行中退出会把 ● 留在已死的 tab 上；退屏前复原成空闲标题，tab 上正好留个「这是 sph 会话」的标记。
    this.refreshTabTitle(true);
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
      mcpServerCount: this.deps.mcp()?.listServers().length ?? 0,
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
      case 'history':
        await commandHistory(this);
        break;
      case 'new':
        await commandNewSession(this);
        break;
      case 'resume':
        await commandResume(this, argument);
        break;
      case 'skills':
        await this.commandSkills();
        break;
      case 'plugins':
        await this.commandPlugins();
        break;
      case 'mcps':
        await commandMcps(this);
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
        await commandModel(this, argument);
        break;
      case 'provider':
        await commandProvider(this, argument);
        break;
      case 'effort':
        await commandEffort(this, argument);
        break;
      case 'permission':
        await commandPermission(this, argument);
        break;
      case 'export':
        await commandExport(this, argument);
        break;
      default:
        break;
    }
  }

  /**
   * `/help`：命令与键位清单。命令表从注册表取数；键位清单由注册表驱动（app-keybindings
   * 的 when 字段分组）：新增键位只需改注册表，帮助自动跟上——手写清单必然漂移，
   * 这次收编就是为了消灭它。
   */
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
    const grouped = new Map<string, string[]>();
    for (const definition of Object.values(APP_KEYBINDINGS) as AppKeybindingDefinition[]) {
      const entry = `- \`${formatKeyText(definition.keys.join('/'))}\` — ${definition.description}`;
      const group = grouped.get(definition.when) ?? [];
      group.push(entry);
      grouped.set(definition.when, group);
    }
    for (const [when, entries] of grouped) {
      lines.push(`### ${when === 'always' ? 'Available anytime' : when}`);
      lines.push(...entries);
    }
    lines.push('');
    lines.push('## Queue (mouse)');
    lines.push('- Hover a queued row for [↑] [↓] [Send now] [edit] [cancel] buttons');
    lines.push('- Click a row to select it; `[edit]` takes it back to the input (queued order preserved)');
    lines.push('');
    lines.push('## Editor');
    lines.push('- `/` — slash-command autocomplete in the editor');
    lines.push('- `Enter` while a turn is running — queue the message (delivered after the turn ends)');
    lines.push('- `Alt+Enter` — queue a follow-up that starts after this turn');
    await showMessageDialog(this.ui, { title: 'Help', text: lines.join('\n') });
  }

  /**
   * 重新扫一遍技能目录，而不是复用本轮提示词里那份目录。
   *
   * 会话中途新建一个 skill 是正常用法，当场扫就能立刻看到；代价只是读几个 SKILL.md 的文件头。
   * 与当前轮次提示词有分歧时以本弹窗为准——下一轮的提示词就会跟上。
   */
  /**
   * `/plugins`：装了哪些插件、各自贡献了什么、谁没装起来。
   *
   * 只读且每次重新取：插件不会在会话中途装载或卸载，但「我的工具怎么不见了」这类问题
   * 恰恰是在改了配置、下次启动之后才被注意到的，状态必须来自当下这份报告而不是快照。
   */
  private async commandPlugins(): Promise<void> {
    const report = this.deps.pluginReport();
    await showMessageDialog(this.ui, {
      title: 'Plugins',
      text: renderPluginsReport(report),
      hint: 'Esc close · plugin state is fixed for this process',
    });
  }

  private async commandSkills(): Promise<void> {
    const { catalog, warnings } = scanSkills(this.deps.workspaceRoot);
    await showMessageDialog(this.ui, {
      title: 'Skills',
      text: renderSkillsReport({ catalog, warnings, roots: skillRoots(this.deps.workspaceRoot) }),
      hint: 'Esc close · re-scanned on every open',
    });
  }

  // ------------------------------------------------------------------ 会话切换落地

  /** /new 确认后的落地（SessionCommandHost）：锁成功才切，失败仍占用当前会话。 */
  public startSession(next: JsonlSession): void {
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

  /** /resume 的落地（SessionCommandHost）：claim 会话锁、换会话文件、回放恢复。 */
  public switchToSession(id: string): void {
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
      // 指示器清掉后活动词已归位；这里刷新 tab 标题落回空闲，不能再用 setActivity 记词——
      // 空闲态的假活动词会让 ● 一直挂在 tab 上。
      this.refreshTabTitle();
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
    if (this.projection.liveSubagentCount > 0) return;
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
        mcpTools: this.deps.mcp()?.listTools() ?? [],
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
    this.projection.breakToolGroup();
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
  public addRecap(summary: string): void {
    this.projection.breakToolGroup();
    this.chatContainer.addChild(new RecapMessageComponent(summary));
    this.ui.requestRender();
  }

  // ------------------------------------------------------------------ 计划模式

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

  // ------------------------------------------------------------------ Goal

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

  // ------------------------------------------------------------------ 模型/审批的应用（设置命令的宿主回调）

  /** 设置命令读取当前值（SettingsCommandHost）。 */
  public currentProvider(): string {
    return this.provider;
  }

  public currentModel(): string {
    return this.model;
  }

  public currentEffort(): ReasoningEffort | undefined {
    return this.effort;
  }

  public currentApproval(): ApprovalMode {
    return this.approval;
  }

  /**
   * 应用模型选择：重建 client、记事件、写回配置（可能同时切换 provider）。
   *
   * 声明了容量的模型一并生效 contextWindow / maxTokens——换模型后窗口不再是旧的；
   * 未声明的模型保持现值，兜底由 config.toml 的全局值管。
   */
  public applyModel(model: string, providerName?: string): void {
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

  public applyEffort(effort: ReasoningEffort): void {
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
  public applyApi(api: ApiProtocol, provider: ProviderDeclaration, modelId: string): void {
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

  public applyApproval(mode: ApprovalMode): void {
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
  public applyEditorBorder(): void {
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

  // ------------------------------------------------------------------ 杂项

  private clearChat(): void {
    this.transcriptView?.setPinY(undefined);
    this.chatContainer.clear();
    this.projection.clear();
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
