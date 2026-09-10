/**
 * TUI 主循环：键盘路由 + agent 轮次调度 + 命令面板。
 *
 * 关键结构是「单一按键消费者」：runTurn 与本地的审批/提问浮层都要等用户输入，但它们
 * 不能各自去读 stdin。所有按键统一进 dispatch()，由它按当前 phase 路由到浮层或输入行，
 * 浮层用 Promise 把结果回给等待中的 agent 调用，从而不会出现两处抢 stdin 的情况。
 *
 * 输出分两条路径：
 *   - 滚动区：对话正文、工具结果、命令反馈，写进去就不再变（终端自己管滚动回看）；
 *   - 活动区：底部会重绘的浮层/输入行/状态行，由 Terminal 按行数精确擦除重画。
 * 因此任何一次向滚动区写入之前，都必须先清活动区，写完再由 render() 画回来。
 *
 * 已知限制：终端 resize 后活动区的行数记账可能失真，重绘时可能出现一行残留。
 */

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentListener } from '../agent/events.js';
import { runTurn } from '../agent/loop.js';
import { createLlmClassifier } from '../approval/auto.js';
import type { ApprovalMode, ApprovalRequest } from '../approval/policy.js';
import type { ApiProtocol } from '../config/load.js';
import { REASONING_EFFORTS, type LlmClient, type ReasoningEffort } from '../llm/openai.js';
import type { McpHub } from '../mcp/hub.js';
import type { JobBoard } from '../runtime/jobs.js';
import type { PersistentShell } from '../runtime/persistent-shell.js';
import type { TodoList } from '../runtime/todos.js';
import type { SandboxHandle } from '../sandbox/open.js';
import { exportJson, exportMarkdown } from '../session/export.js';
import { createSession, JsonlSession, listSessions, setCurrentSession, type SessionInfo } from '../session/store.js';
import { colorEnabled, createStyler, type Styler } from './ansi.js';
import { InteractiveApprover } from './approver.js';
import {
  backspace, deleteForward, emptyEditor, insertText, killToEnd, killToStart, killWordBefore,
  moveEnd, moveHome, moveLeft, moveRight, setText, type EditorState,
} from './editor.js';
import { KeyParser, type Key } from './keys.js';
import { applyAgentEvent, createState, todoSummary, transcriptFromMessages, type MenuItem, type TuiState } from './state.js';
import { InputQueue, Terminal } from './terminal.js';
import { renderBanner, renderEntry, renderLive, type ViewOptions } from './view.js';

export interface TuiDeps {
  workspaceRoot: string;
  sessionDir: string;
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
  { id: 'model', label: '/model', hint: '查看 / 切换模型' },
  { id: 'effort', label: '/effort', hint: '查看 / 设置推理档位' },
  { id: 'approval', label: '/approval', hint: '查看 / 设置审批模式：ask | auto | yolo' },
  { id: 'todo', label: '/todo', hint: '查看任务清单' },
  { id: 'jobs', label: '/jobs', hint: '查看后台任务' },
  { id: 'export', label: '/export', hint: '导出当前会话（md | json）' },
  { id: 'clear', label: '/clear', hint: '清屏' },
  { id: 'quit', label: '/quit', hint: '退出' },
];

/** 命令名集合：由菜单项派生，避免菜单与解析表漂移。 */
const COMMAND_NAMES = new Set<string>([...COMMAND_ITEMS.map((item) => item.id), 'exit', 'switch']);

const HELP_LINES = [
  '命令',
  ...COMMAND_ITEMS.map((item) => `  ${item.label.padEnd(16)}${item.hint}`),
  '  /switch <id>    切换到指定会话（支持 id 前缀）',
  '',
  '快捷键：Enter 发送 · / 打开命令菜单 · Ctrl+K 全部操作 · ↑↓ 历史 · Ctrl+L 清屏',
  '        Esc 中断本轮 / 取消浮层 · Ctrl+C 运行中中断、空闲时退出',
];

/** /sessions 回放与首屏最多写多少条，避免一次刷屏几十屏。 */
const REPLAY_LIMIT = 40;
const HISTORY_LIMIT = 200;

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

  private rawBuffer = '';
  private atLineStart = true;
  private spinnerTimer?: NodeJS.Timeout;
  private escTimer?: NodeJS.Timeout;
  private menuKind: 'commands' | 'sessions' = 'commands';
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
      this.commitLines(renderBanner(this.state, this.viewOptions()));
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
    if (this.state.phase === 'running') {
      if (key.kind === 'escape' || (key.kind === 'ctrl' && key.key === 'c')) this.abortTurn();
      return;
    }
    return this.handleIdleKey(key);
  }

  private handleIdleKey(key: Key): void {
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
      if (key.key === 'k') return this.openMenu('commands', '');
      if (key.key === 'l') {
        this.terminal.clearScreen();
        this.render();
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
   * 一旦出现空格说明用户在写参数，菜单收起、Enter 直接执行。
   */
  private syncCommandMenu(): void {
    const text = this.state.editor.text;
    if (/^\/\S*$/.test(text)) {
      if (!this.state.menu) {
        this.menuKind = 'commands';
        this.state.menu = { title: '命令', items: [], index: 0, filter: '' };
        this.state.phase = 'menu';
      }
      this.syncMenuFilter();
      return;
    }
    if (this.state.menu && this.menuKind === 'commands') {
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
    if (key.kind === 'escape' || (key.kind === 'ctrl' && key.key === 'c')) return this.closeMenu();
    if (key.kind === 'up' || key.kind === 'down') {
      if (menu.items.length === 0) return;
      const delta = key.kind === 'up' ? -1 : 1;
      menu.index = (menu.index + delta + menu.items.length) % menu.items.length;
      return this.render();
    }
    if (key.kind === 'enter') return this.runMenuSelection();
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
    menu.filter = raw.startsWith('/') ? raw.slice(1) : raw;
    const query = menu.filter.toLowerCase();
    menu.items = this.menuItems(this.menuKind).filter((item) =>
      query === '' || item.id.toLowerCase().startsWith(query) || item.label.toLowerCase().includes(query),
    );
    menu.index = Math.min(menu.index, Math.max(0, menu.items.length - 1));
  }

  private menuItems(kind: 'commands' | 'sessions'): MenuItem[] {
    if (kind === 'commands') return [...COMMAND_ITEMS];
    return this.sessions.map((info) => ({
      id: info.id,
      label: info.id.slice(0, 24),
      hint: `消息 ${info.messages} · ${info.preview || '(空会话)'}`,
    }));
  }

  private openMenu(kind: 'commands' | 'sessions', initial: string): void {
    this.menuKind = kind;
    this.state.editor = initial === '' ? emptyEditor() : setText(initial);
    this.state.menu = { title: kind === 'commands' ? '命令' : '会话', items: [], index: 0, filter: '' };
    this.state.phase = 'menu';
    this.syncMenuFilter();
    this.render();
  }

  private closeMenu(): void {
    this.state.menu = undefined;
    this.state.editor = emptyEditor();
    this.state.phase = this.running ? 'running' : 'idle';
    this.render();
  }

  private runMenuSelection(): void {
    const menu = this.state.menu;
    if (!menu) return;
    const typed = this.state.editor.text.trim();
    const parsed = parseSlashInput(typed);
    if (menu.items.length > 0) {
      const item = menu.items[Math.min(menu.index, menu.items.length - 1)];
      this.closeMenu();
      if (this.menuKind === 'sessions') this.switchSession(item.id);
      else this.executeCommand(item.id, '', true);
      return;
    }
    if (parsed) {
      this.closeMenu();
      this.executeCommand(parsed.name, parsed.args, true);
      return;
    }
    this.state.notice = typed === '' ? '没有可执行的命令' : `未知命令：${typed}`;
    this.render();
  }

  // ---------------------------------------------------------------- 命令

  private submitSlash(text: string): void {
    const parsed = parseSlashInput(text);
    if (!parsed || !COMMAND_NAMES.has(parsed.name)) {
      this.state.notice = `未知命令：${text}（输入 / 查看全部命令）`;
      this.render();
      return;
    }
    this.rememberHistory(text);
    this.executeCommand(parsed.name, parsed.args, true);
  }

  private executeCommand(name: string, args: string, clearInput: boolean): void {
    if (clearInput) this.state.editor = emptyEditor();
    this.state.notice = undefined;
    switch (name) {
      case 'help':
        this.commitLines(HELP_LINES);
        break;
      case 'new':
        this.session = createSession(this.deps.sessionDir, this.deps.workspaceRoot);
        this.state.sessionId = this.session.id;
        this.commitLines([`—— 新会话 ${this.session.id} ——`]);
        break;
      case 'sessions':
        void this.openSessionsMenu();
        return;
      case 'switch':
        void this.switchTo(args.trim());
        return;
      case 'status':
        this.state.phase = 'status';
        break;
      case 'plan':
        this.setPlan(!this.planMode);
        this.state.notice = `计划模式：${this.planMode ? 'on（仅只读工具，计划经你审批后才执行）' : 'off'}`;
        break;
      case 'model':
        if (args.trim() === '') this.state.notice = `当前模型：${this.model} · 用法：/model <name>`;
        else this.setModel(args.trim());
        break;
      case 'effort':
        this.setEffort(args.trim());
        break;
      case 'approval':
        this.setApprovalMode(args.trim());
        break;
      case 'todo':
        this.commitLines(this.todoLines());
        break;
      case 'jobs':
        this.commitLines(this.jobLines());
        break;
      case 'export':
        this.exportSession(args.trim());
        break;
      case 'clear':
        this.terminal.clearScreen();
        break;
      case 'quit':
      case 'exit':
        this.quit();
        return;
      default:
        this.state.notice = `未知命令：/${name}`;
        break;
    }
    this.render();
  }

  private async openSessionsMenu(): Promise<void> {
    try {
      this.sessions = await listSessions(this.deps.sessionDir);
    } catch (error) {
      this.state.notice = `读取会话失败：${message(error)}`;
      this.render();
      return;
    }
    if (this.sessions.length === 0) {
      this.state.notice = '当前工作区还没有历史会话';
      this.render();
      return;
    }
    this.openMenu('sessions', '');
  }

  /** 菜单路径：会话列表已加载，直接按 id 激活。 */
  private switchSession(id: string): void {
    const file = join(this.deps.sessionDir, `${id}.jsonl`);
    if (!existsSync(file)) {
      this.state.notice = `会话文件不存在：${id}`;
      this.render();
      return;
    }
    setCurrentSession(this.deps.sessionDir, id, this.deps.workspaceRoot);
    this.session = new JsonlSession(this.deps.sessionDir, id);
    this.state.sessionId = id;
    const entries = transcriptFromMessages(this.session.readMessages());
    const shown = entries.slice(-REPLAY_LIMIT);
    const options = this.viewOptions();
    const head = `—— 已切换到会话 ${id}（历史 ${entries.length} 条${shown.length < entries.length ? `，仅显示最近 ${shown.length} 条` : ''}）——`;
    this.commitLines([head, ...shown.flatMap((entry) => renderEntry(entry, options))]);
    this.render();
  }

  /** `/switch <id 前缀>`：会话列表可能还没加载过，先按需取一次。 */
  private async switchTo(prefix: string): Promise<void> {
    if (prefix === '') {
      this.state.notice = '用法：/switch <会话 id 前缀>（或用 /sessions 选择）';
      this.render();
      return;
    }
    if (this.sessions.length === 0) {
      try {
        this.sessions = await listSessions(this.deps.sessionDir);
      } catch (error) {
        this.state.notice = `读取会话失败：${message(error)}`;
        this.render();
        return;
      }
    }
    const hit = this.sessions.find((info) => info.id === prefix) ?? this.sessions.find((info) => info.id.startsWith(prefix));
    if (!hit) {
      this.state.notice = `未找到会话：${prefix}（试试 /sessions）`;
      this.render();
      return;
    }
    this.switchSession(hit.id);
  }

  private setModel(name: string): void {
    this.model = name;
    this.client = this.deps.makeClient({ model: this.model, api: this.api, effort: this.effort });
    this.state.model = name;
    this.state.notice = `模型已切换：${name}`;
  }

  private setEffort(level: string): void {
    if (level === '') {
      this.state.notice = `当前推理档位：${this.effort ?? 'off（未设置）'} · 可选：${REASONING_EFFORTS.join(' | ')}`;
      return;
    }
    if (!(REASONING_EFFORTS as readonly string[]).includes(level)) {
      this.state.notice = `无效档位：${level} · 可选：${REASONING_EFFORTS.join(' | ')}`;
      return;
    }
    this.effort = level as ReasoningEffort;
    this.client = this.deps.makeClient({ model: this.model, api: this.api, effort: this.effort });
    this.state.effort = this.effort;
    this.state.notice = `推理档位：${this.effort}`;
  }

  private setApprovalMode(mode: string): void {
    if (mode === '') {
      this.state.notice = `当前审批模式：${this.approvalModeValue} · 可选：ask | auto | yolo`;
      return;
    }
    if (mode !== 'ask' && mode !== 'auto' && mode !== 'yolo') {
      this.state.notice = `无效审批模式：${mode} · 可选：ask | auto | yolo`;
      return;
    }
    this.approvalModeValue = mode;
    this.state.approvalMode = mode;
    this.state.notice = `审批模式：${mode}`;
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
      this.state.notice = `已导出：${file}`;
    } catch (error) {
      this.state.notice = `导出失败：${message(error)}`;
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
    this.state.notice = undefined;
    this.state.phase = 'running';
    this.commitLines(renderEntry({ kind: 'user', text: prompt }, this.viewOptions()));
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
      const options = this.viewOptions();
      if (controller.signal.aborted) this.commitLines([...renderEntry({ kind: 'notice', text: '本轮已中断' }, options)]);
      else this.commitLines([...renderEntry({ kind: 'error', text: message(error) }, options)]);
    } finally {
      this.running = false;
      this.abort = undefined;
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

  private readonly listener: AgentListener = (event) => {
    if (event.type === 'text') {
      applyAgentEvent(this.state, event);
      this.appendRaw(event.text);
      return;
    }
    const thinkingIndex = this.state.thinkingIndex;
    applyAgentEvent(this.state, event);
    const options = this.viewOptions();
    if (event.type === 'thinking_end') {
      // thinking_end 不新增条目而是回填既有条目，因此要单独取出来渲染。
      const entry = thinkingIndex === undefined ? undefined : this.state.entries[thinkingIndex];
      if (entry) this.commitLines(renderEntry(entry, options));
    } else if (event.type === 'status' || event.type === 'tool_start' || event.type === 'tool_end' || event.type === 'error') {
      // 取末尾条目而不是按下标切片：条目上限触发丢头时下标会整体左移。
      const entry = this.state.entries[this.state.entries.length - 1];
      if (entry) this.commitLines(renderEntry(entry, options));
    }
    if (event.type === 'tool_end') this.refreshCounters();
    this.render();
  };

  private abortTurn(): void {
    if (!this.running) return;
    this.abort?.abort();
    this.state.notice = '正在中断本轮…';
    this.render();
  }

  private refreshCounters(): void {
    this.state.jobs = this.deps.jobs.list().filter((job) => job.status === 'running').length;
    this.state.todo = todoSummary(this.deps.todos.list());
  }

  // ---------------------------------------------------------------- 输出与重绘

  private appendRaw(text: string): void {
    this.rawBuffer += text;
    if (this.rawBuffer.length >= 512 || text.includes('\n')) this.flushRaw();
  }

  private flushRaw(): void {
    if (this.rawBuffer === '') return;
    const text = this.rawBuffer;
    this.rawBuffer = '';
    this.terminal.clearLive();
    this.terminal.write(text);
    this.atLineStart = text.endsWith('\n');
  }

  private commitLines(lines: readonly string[]): void {
    if (lines.length === 0) return;
    this.flushRaw();
    this.terminal.clearLive();
    this.terminal.write(`${this.atLineStart ? '' : '\n'}${lines.join('\n')}\n`);
    this.atLineStart = true;
  }

  private render(): void {
    if (!this.terminal.active) return;
    this.flushRaw();
    const options = this.viewOptions();
    this.lastSize = { width: options.width, height: options.height };
    const { lines, cursor } = renderLive(this.state, options);
    this.terminal.drawLive(lines, cursor);
  }

  private viewOptions(): ViewOptions {
    const size = this.terminal.size();
    return { width: size.width, height: size.height, styler: this.styler };
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

  private handleResize(): void {
    const size = this.terminal.size();
    if (size.width === this.lastSize.width && size.height === this.lastSize.height) return;
    // 重排后旧的行数记账不再可信：只重置记账，不做上移擦除，避免误删已提交内容。
    this.terminal.resetLive();
    this.render();
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
