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
import { REASONING_EFFORTS, type LlmClient, type ReasoningEffort } from '../llm/openai.js';
import type { McpHub } from '../mcp/hub.js';
import type { JobBoard } from '../runtime/jobs.js';
import type { PersistentShell } from '../runtime/persistent-shell.js';
import type { TodoList } from '../runtime/todos.js';
import type { SandboxHandle } from '../sandbox/open.js';
import { exportJson, exportMarkdown } from '../session/export.js';
import { createSession, JsonlSession, listSessions, setCurrentSession, type SessionInfo } from '../session/store.js';
import { colorEnabled, createStyler, truncate, type Styler } from './ansi.js';
import { InteractiveApprover } from './approver.js';
import {
  backspace, deleteForward, emptyEditor, insertText, killToEnd, killToStart, killWordBefore,
  moveEnd, moveHome, moveLeft, moveRight, setText, type EditorState,
} from './editor.js';
import { KeyParser, type Key } from './keys.js';
import { readGitBranch } from './git.js';
import { applyAgentEvent, createState, todoSummary, transcriptFromMessages, type MenuItem, type NoticeLevel, type TranscriptEntry, type TuiState } from './state.js';
import { InputQueue, Terminal } from './terminal.js';
import {
  composeFrame, maxScroll, renderBanner, renderEntry, renderLive, renderToolBlock, type ViewOptions,
} from './view.js';
import type { ToolCallView } from './tool-view.js';

export interface TuiDeps {
  workspaceRoot: string;
  sessionDir: string;
  /** config.toml 路径：/model、/effort、/approval 的选择写回这里，下次启动仍生效。 */
  configPath: string;
  contextWindow: number;
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
  makeClient(options: { model: string; api: ApiProtocol; effort?: ReasoningEffort }): LlmClient;
}

const COMMAND_ITEMS: readonly MenuItem[] = [
  { id: 'help', label: '/help', hint: '列出全部命令与快捷键' },
  { id: 'new', label: '/new', hint: '新建会话' },
  { id: 'sessions', label: '/sessions', hint: '浏览并切换历史会话' },
  { id: 'status', label: '/status', hint: '查看完整状态' },
  { id: 'plan', label: '/plan', hint: '切换计划模式（只读调研 + 计划审批）' },
  { id: 'model', label: '/model', hint: '查看 / 切换模型（选择写回 config.toml）' },
  { id: 'effort', label: '/effort', hint: '查看 / 设置推理档位（选择写回 config.toml）' },
  { id: 'approval', label: '/approval', hint: '查看 / 设置审批模式：ask | auto | yolo（写回 config.toml）' },
  { id: 'todo', label: '/todo', hint: '查看任务清单' },
  { id: 'jobs', label: '/jobs', hint: '查看后台任务' },
  { id: 'export', label: '/export', hint: '导出当前会话（md | json）' },
  { id: 'clear', label: '/clear', hint: '清屏' },
  { id: 'quit', label: '/quit', hint: '退出' },
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
 * 动态列表（/sessions、/switch 从会话目录读），要么需要自由文本而没有可枚举候选（/model）。
 */
const OPTION_TABLE: Readonly<Record<string, readonly OptionEntry[]>> = {
  approval: [
    { value: 'ask', hint: '每个受审工具都问你' },
    { value: 'auto', hint: '先过 LLM 审查器，否决时升级到你' },
    { value: 'yolo', hint: '全部放行，不再询问（危险）' },
  ],
  effort: REASONING_EFFORTS.map((level) => ({
    value: level,
    hint: level === 'off' ? '不上报推理档位' : `${level} 推理档位`,
  })),
  export: [
    { value: 'md', hint: '导出为 Markdown' },
    { value: 'json', hint: '导出为原始 JSON' },
  ],
};

const HELP_LINES = [
  '命令',
  ...COMMAND_ITEMS.map((item) => `  ${item.label.padEnd(16)}${item.hint}`),
  '  /switch <id>    切换到指定会话（支持 id 前缀）',
  '',
  '快捷键：Enter 发送 | / 打开命令菜单 | Ctrl+K 全部操作 | 上下键 历史 | Ctrl+L 清空视图',
  '        PgUp / PgDn 回看历史（Esc 回到最新） | Esc 中断本轮 / 取消浮层 | Ctrl+C 退出',
  '',
  '界面符号只用 ASCII：东亚歧义宽度字符（中点、省略号、箭头）在部分终端按 2 列渲染，',
  '会让底部活动区的宽度计算失真并吃掉一行已提交内容，因此一律不用。',
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
  private api: ApiProtocol;
  private effort?: ReasoningEffort;
  private approvalModeValue: ApprovalMode;
  private planMode = false;
  private running = false;
  private abort?: AbortController;

  /** 对话历史：可重排的块列表（正文、工具块、横幅、命令反馈都按块存）。 */
  private readonly body: BodyBlock[] = [];
  /** 正在流式增长的块；它每帧重排，其余块只在宽度变化时重排。 */
  private streamBlock?: BodyBlock;
  /** 合并同一时刻内的多次重绘请求（流式正文可能在一个事件循环里来好几段）。 */
  private renderQueued = false;
  /** 上一帧历史视口的高度，PgUp/PgDn 按它翻页。 */
  private lastBodyRows = 10;
  /** 本步攒下的工具调用，等这一步结束一次性渲染成块。 */
  private pendingTools: ToolCallView[] = [];
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
  private sessions: SessionInfo[] = [];
  private lastSize = { width: 0, height: 0 };

  constructor(private readonly deps: TuiDeps) {
    this.session = deps.session;
    this.model = deps.model;
    this.api = deps.api;
    this.effort = deps.effort;
    this.approvalModeValue = deps.approvalMode;
    this.client = deps.makeClient({ model: deps.model, api: deps.api, effort: deps.effort });
    this.styler = createStyler(colorEnabled());
    this.terminal = new Terminal((text) => this.feed(text));
    // 分类器按需构造：/model 换模型后审查器要跟着用新 client，闭包不能固化旧实例。
    this.approver = new InteractiveApprover(this, (request) => createLlmClassifier(this.client)(request));
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
    });
  }

  // ---------------------------------------------------------------- 生命周期

  async run(): Promise<void> {
    this.terminal.enter(() => this.handleResize());
    const restoreOnExit = (): void => this.terminal.restore();
    process.on('exit', restoreOnExit);
    try {
      this.commit((width) => renderBanner(this.state, this.optionsAt(width)));
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
    if (this.state.prompt) return this.handlePromptKey(key);
    if (this.state.phase === 'menu') return this.handleMenuKey(key);
    if (this.state.phase === 'status') {
      this.state.phase = 'idle';
      this.render();
      return;
    }
    if (this.handleScrollKey(key)) return;
    if (this.state.phase === 'running') {
      if (key.kind === 'escape' || (key.kind === 'ctrl' && key.key === 'c')) this.abortTurn();
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
    if (key.kind === 'pageup') {
      this.scrollTo(this.state.scroll + this.pageSize());
      return true;
    }
    if (key.kind === 'pagedown') {
      this.scrollTo(this.state.scroll - this.pageSize());
      return true;
    }
    // Esc 分两级：回看中先回到底部，再按一次才轮到「中断本轮」。避免翻历史时误中断。
    if (key.kind === 'escape' && this.state.scroll > 0) {
      this.scrollTo(0);
      return true;
    }
    return false;
  }

  /** 一屏可翻的行数，去掉与上一屏的重叠部分。 */
  private pageSize(): number {
    return Math.max(1, this.lastBodyRows - PAGE_OVERLAP);
  }

  private scrollTo(offset: number): void {
    // 上限由 render() 按历史长度夹住。
    this.state.scroll = Math.max(0, offset);
    this.render();
  }

  private handleIdleKey(key: Key): void {
    // 任何输入都表示「回到最新」：正在打字却还盯着历史会很别扭。
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
      if (key.key === 'c') return this.quit();
      if (key.key === 'd' && this.state.editor.text === '') return this.quit();
      if (key.key === 'k') return this.openCommandMenu('');
      if (key.key === 'l') {
        this.clearBody();
        return;
      }
    }
    const next = applyEditorKey(this.state.editor, key);
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
      const char = key.kind === 'text' ? key.text.toLowerCase() : '';
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
      const next = applyEditorKey(prompt.editor, key);
      if (!next) return;
      prompt.editor = next;
      return this.render();
    }

    // plan：空输入时按 y 批准；有输入时 Enter 作为驳回意见。
    if (key.kind === 'text' && key.text.toLowerCase() === 'y' && prompt.editor.text === '') {
      return this.settlePrompt(() => prompt.resolve({ approved: true }));
    }
    if (key.kind === 'enter') {
      const feedback = prompt.editor.text.trim();
      return this.settlePrompt(() => prompt.resolve(feedback === '' ? { approved: false } : { approved: false, feedback }));
    }
    if (cancel) return this.settlePrompt(() => prompt.resolve({ approved: false }));
    const next = applyEditorKey(prompt.editor, key);
    if (!next) return;
    prompt.editor = next;
    this.render();
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
    const next = applyEditorKey(this.state.editor, key);
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
    if (!this.menuOptions) return [...COMMAND_ITEMS];
    const current = this.currentOptionValue(this.menuOptions.parent);
    return this.menuOptions.entries.map((entry) => ({
      id: entry.value,
      label: entry.value,
      hint: entry.value === current ? `${entry.hint}（当前）` : entry.hint,
    }));
  }

  /** 一级菜单：`/` 或 Ctrl+K 打开。initial 是输入行已有内容（`/xxx`）。 */
  private openCommandMenu(initial: string): void {
    this.menuOptions = undefined;
    this.state.editor = initial === '' ? emptyEditor() : setText(initial);
    this.state.menu = { title: '命令', items: [], index: 0, filter: '' };
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
    this.state.menu = { title: `命令 | /${parent}`, items: [], index: 0, filter: '', nested: true };
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
      this.notify(typed === '' ? '没有可执行的命令' : `未知命令：${typed}`, 'warn');
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
      this.notify(`未知命令：${text}（输入 / 查看全部命令）`, 'warn');
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
        this.commit((width) => [truncate(`== 新会话 ${this.session.id} ==`, width, '')]);
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
        this.notify(`计划模式：${this.planMode ? 'on（仅只读工具，计划经你审批后才执行）' : 'off'}`);
        break;
      case 'model':
        if (args.trim() === '') this.notify(`当前模型：${this.model} | 用法：/model <name>`);
        else this.setModel(args.trim());
        break;
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
        this.notify(`未知命令：/${name}`, 'warn');
        break;
    }
    this.render();
  }

  private async openSessionsMenu(): Promise<void> {
    try {
      this.sessions = await listSessions(this.deps.sessionDir);
    } catch (error) {
      this.notify(`读取会话失败：${message(error)}`, 'error');
      this.render();
      return;
    }
    if (this.sessions.length === 0) {
      this.notify('当前工作区还没有历史会话');
      this.render();
      return;
    }
    this.openOptionsMenu(
      'sessions',
      this.sessions.map((info) => ({
        value: info.id,
        hint: `消息 ${info.messages} | ${info.preview || '(空会话)'}`,
      })),
      this.state.sessionId,
    );
  }

  /** 菜单路径：会话列表已加载，直接按 id 激活。 */
  private switchSession(id: string): void {
    const file = join(this.deps.sessionDir, `${id}.jsonl`);
    if (!existsSync(file)) {
      this.notify(`会话文件不存在：${id}`, 'error');
      this.render();
      return;
    }
    setCurrentSession(this.deps.sessionDir, id, this.deps.workspaceRoot);
    this.session = new JsonlSession(this.deps.sessionDir, id);
    this.state.sessionId = id;
    const entries = transcriptFromMessages(this.session.readMessages());
    const shown = entries.slice(-REPLAY_LIMIT);
    const head = `== 已切换到会话 ${id} | 历史 ${entries.length} 条${shown.length < entries.length ? `，仅显示最近 ${shown.length} 条` : ''} ==`;
    this.commit((width) => [truncate(head, width, ''), ...shown.flatMap((entry) => renderEntry(entry, this.optionsAt(width)))]);
    this.render();
  }

  /** `/switch <id 前缀>`：会话列表可能还没加载过，先按需取一次。 */
  private async switchTo(prefix: string): Promise<void> {
    if (prefix === '') {
      this.notify('用法：/switch <会话 id 前缀>（或用 /sessions 选择）');
      this.render();
      return;
    }
    if (this.sessions.length === 0) {
      try {
        this.sessions = await listSessions(this.deps.sessionDir);
      } catch (error) {
        this.notify(`读取会话失败：${message(error)}`, 'error');
        this.render();
        return;
      }
    }
    const hit = this.sessions.find((info) => info.id === prefix) ?? this.sessions.find((info) => info.id.startsWith(prefix));
    if (!hit) {
      this.notify(`未找到会话：${prefix}（试试 /sessions）`, 'warn');
      this.render();
      return;
    }
    this.switchSession(hit.id);
  }

  private setModel(name: string): void {
    this.model = name;
    this.client = this.deps.makeClient({ model: this.model, api: this.api, effort: this.effort });
    this.state.model = name;
    const warning = this.persistConfig({ model: name });
    this.notify(`模型已切换：${name}${warning}`, warning === '' ? 'success' : 'warn');
  }

  private setEffort(level: string): void {
    if (level === '') {
      this.notify(`当前推理档位：${this.effort ?? 'off（未设置）'} | 可选：${REASONING_EFFORTS.join(' | ')}`);
      return;
    }
    if (!(REASONING_EFFORTS as readonly string[]).includes(level)) {
      this.notify(`无效档位：${level} | 可选：${REASONING_EFFORTS.join(' | ')}`, 'warn');
      return;
    }
    this.effort = level as ReasoningEffort;
    this.client = this.deps.makeClient({ model: this.model, api: this.api, effort: this.effort });
    this.state.effort = this.effort;
    const warning = this.persistConfig({ reasoning_effort: this.effort });
    this.notify(`推理档位：${this.effort}${warning}`, warning === '' ? 'success' : 'warn');
  }

  /**
   * 写回 config.toml。
   *
   * 失败只降级成提示、不抛：切换在本次进程内已经生效，不该因为磁盘只读/权限问题把已经
   * 生效的改动回滚掉。但也绝不静默——用户特意要的是「下次启动还在」。
   */
  private persistConfig(patch: Record<string, string>): string {
    try {
      updateConfigFile(this.deps.configPath, patch);
      return ` | 已写入 ${this.deps.configPath}`;
    } catch (error) {
      return ` | 未能写入 ${this.deps.configPath}：${message(error)}`;
    }
  }

  private setApprovalMode(mode: string): void {
    if (mode === '') {
      this.notify(`当前审批模式：${this.approvalModeValue} | 可选：${APPROVAL_MODES.join(' | ')}`);
      return;
    }
    if (!(APPROVAL_MODES as readonly string[]).includes(mode)) {
      this.notify(`无效审批模式：${mode} | 可选：${APPROVAL_MODES.join(' | ')}`, 'warn');
      return;
    }
    this.approvalModeValue = mode as ApprovalMode;
    this.state.approvalMode = mode;
    const warning = this.persistConfig({ approval: mode });
    this.notify(`审批模式：${mode}${warning}`, warning === '' ? 'success' : 'warn');
  }

  private setPlan(enabled: boolean): void {
    this.planMode = enabled;
    this.state.planMode = enabled;
  }

  private exportSession(format: string): void {
    const kind = format === 'json' ? 'json' : 'md';
    const file = join(this.deps.sessionDir, `${this.session.id}.${kind}`);
    try {
      writeFileSync(file, kind === 'json' ? exportJson(this.session) : exportMarkdown(this.session), 'utf8');
      this.notify(`已导出：${file}`, 'success');
    } catch (error) {
      this.notify(`导出失败：${message(error)}`, 'error');
    }
  }

  private todoLines(): string[] {
    const items = this.deps.todos.list();
    if (items.length === 0) return ['任务清单为空（模型还没调用 todo 工具）'];
    const mark = { pending: ' ', in_progress: '>', completed: 'x' } as const;
    return ['任务清单', ...items.map((item) => `  [${mark[item.status]}] ${item.id} ${item.content}`)];
  }

  private jobLines(): string[] {
    const jobs = this.deps.jobs.list();
    if (jobs.length === 0) return ['没有后台任务'];
    return [
      '后台任务',
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
    this.commit((width) => renderEntry({ kind: 'user', text: prompt }, this.optionsAt(width)), { blank: true });
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
        contextWindow: this.deps.contextWindow,
        listener: this.listener,
        signal: controller.signal,
        mcp: this.deps.mcp,
        todos: this.deps.todos,
        jobs: this.deps.jobs,
        persistent: this.deps.persistent,
        planState,
      });
    } catch (error) {
      if (controller.signal.aborted) this.commit((width) => renderEntry({ kind: 'notice', text: '本轮已中断', level: 'warn' }, this.optionsAt(width)), { blank: true });
      else this.commit((width) => renderEntry({ kind: 'error', text: message(error) }, this.optionsAt(width)), { blank: true });
    } finally {
      // 中断 / 报错时工具块可能还挂在缓冲区里，兜底落盘，否则这一轮的调用记录会凭空消失。
      this.flushToolBlock();
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
        else promptState.resolve({ approved: false });
      }
      this.state.phase = 'idle';
      this.refreshCounters();
      this.render();
    }
  }

  /**
   * agent 事件 → 滚动区 / 活动区。
   *
   * 工具调用不逐条落盘，而是先攒进 pendingTools，等这一步的 LLM 调用结束（下一次
   * thinking_start 或轮次结束）再一次性渲染成「工具块」——一屏里 user/assistant/tool
   * 混着刷是最难读的形态。运行中的实时反馈交给活动区的指示器，不靠滚动区刷屏。
   */
  private readonly listener: AgentListener = (event) => {
    if (event.type === 'text') {
      applyAgentEvent(this.state, event);
      this.appendStream();
      return;
    }
    const thinkingIndex = this.state.thinkingIndex;
    applyAgentEvent(this.state, event);
    const now = Date.now();

    switch (event.type) {
      case 'thinking_start':
        // 新的 LLM 调用 = 新的一步，上一步的工具调用到此落成块。
        this.flushToolBlock();
        this.stepToolCount = 0;
        break;
      case 'thinking_end': {
        const entry = thinkingIndex === undefined ? undefined : this.state.entries[thinkingIndex];
        if (entry) this.commit((width) => renderEntry(entry, this.optionsAt(width)));
        break;
      }
      case 'tool_start': {
        this.pendingTools.push({ id: event.id, name: event.name, args: event.args, detail: '' });
        this.toolStartedAt.set(event.id, now);
        this.stepToolCount++;
        this.state.activeTool = {
          name: event.name,
          index: this.stepToolCount,
          total: this.stepToolCount,
          startedAt: now,
        };
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
        this.flushToolBlock();
        const entry = this.state.entries[this.state.entries.length - 1];
        if (entry) this.commit((width) => renderEntry(entry, this.optionsAt(width)), { blank: true });
        break;
      }
      case 'done':
        this.flushToolBlock();
        break;
      default:
        break;
    }
    this.render();
  };

  /** 把攒下的工具调用渲染成一个块写进滚动区。 */
  private flushToolBlock(): void {
    if (this.pendingTools.length === 0) return;
    const block = this.pendingTools;
    this.pendingTools = [];
    this.commit((width) => renderToolBlock(block, this.optionsAt(width)), { blank: true });
  }

  private abortTurn(): void {
    if (!this.running) return;
    this.abort?.abort();
    this.notify('正在中断本轮...', 'warn');
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
    options?: { blank?: boolean },
  ): void {
    this.freezeStream();
    const width = this.viewOptions().width;
    const lines = typeof content === 'function' ? content(width) : content;
    if (lines.length === 0) return;
    // 回看中时新内容不该把视线拽走：偏移跟着一起增长，视口停在原处。
    if (this.state.scroll > 0) this.state.scroll += lines.length + (options?.blank === true ? 1 : 0);
    this.body.push({
      lines,
      width,
      blank: options?.blank === true,
      render: typeof content === 'function' ? content : undefined,
    });
    this.scheduleRender();
  }

  /** 按指定宽度生成渲染选项（历史重排用；高度对正文渲染没有影响）。 */
  private optionsAt(width: number): ViewOptions {
    return { width, height: this.terminal.size().height, styler: this.styler };
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

  /** 历史全部行；顺带按当前宽度重排那些需要重排的块。 */
  private bodyLines(width: number): string[] {
    const out: string[] = [];
    for (const block of this.body) {
      if (block.render && (block.live === true || block.width !== width)) {
        block.lines = block.render(width);
        block.width = width;
      }
      if (block.blank === true && out.length > 0 && out[out.length - 1] !== '') out.push('');
      out.push(...block.lines);
    }
    return out;
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
    this.lastSize = { width: size.width, height: size.height };
    const live = renderLive(this.state, options);
    const body = this.bodyLines(options.width);
    // 夹住偏移：PgUp 顶到开头之后偏移不该继续无限增长，否则要按很多次 PgDn 才回得来。
    this.state.scroll = Math.max(0, Math.min(this.state.scroll, maxScroll(body.length, live.lines.length, size.height)));
    const frame = composeFrame(body, live, options, this.state.scroll);
    this.lastBodyRows = Math.max(1, size.height - live.lines.length);
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
      this.state.prompt = { kind: 'approval', request, note, resolve };
      this.state.phase = 'approval';
      this.render();
    });
  }

  requestAnswer(question: string): Promise<string> {
    return new Promise<string>((resolve) => {
      this.state.prompt = { kind: 'ask', question, editor: emptyEditor(), resolve };
      this.state.phase = 'ask';
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

/** 编辑器按键映射；返回 undefined 表示该键不是编辑动作。 */
function applyEditorKey(editor: EditorState, key: Key): EditorState | undefined {
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
    case 'ctrl':
      if (key.key === 'a') return moveHome(editor);
      if (key.key === 'e') return moveEnd(editor);
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
