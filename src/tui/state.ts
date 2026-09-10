/**
 * TUI 状态模型。
 *
 * 拆成「模型」与「视图」两件事：模型持有可变的会话/输入/运行态，视图（view.ts）
 * 是纯函数。这样渲染可以在没有 TTY 的测试里断言，而交互逻辑不必关心转义序列。
 *
 * 与 agent 的分工：本模块只描述「界面看到什么」，不执行任何工具或 LLM 调用。
 */

import type { AgentEvent } from '../agent/events.js';
import type { ApprovalRequest } from '../approval/policy.js';
import type { SessionMessage } from '../session/types.js';
import type { TodoItem } from '../runtime/todos.js';
import type { EditorState } from './editor.js';
import { emptyEditor } from './editor.js';
import { summarizeToolCall } from './tool-view.js';

export type Phase = 'idle' | 'running' | 'approval' | 'ask' | 'plan' | 'menu' | 'status';

/** 一次性提示的级别：决定颜色与是否自动消失（warn/error 留到用户下一次操作）。 */
export type NoticeLevel = 'info' | 'success' | 'warn' | 'error';

export interface Notice {
  text: string;
  level: NoticeLevel;
}

export interface TranscriptEntry {
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'notice' | 'error';
  text: string;
  /** tool: 工具名。 */
  label?: string;
  /** tool: 工具调用 id——并行调用时靠它把结果回填到发起条目，不能依赖顺序。 */
  id?: string;
  /** tool: 入参，用于在拿到结果后重算摘要。 */
  args?: Record<string, unknown>;
  /** tool: 一行摘要（由 tool-view 推导）。 */
  summary?: string;
  /** tool: 结果正文。 */
  detail?: string;
  /** notice/error: 级别，决定着色。 */
  level?: NoticeLevel;
  /** 工具结果的成败着色。 */
  ok?: boolean;
  /** 折叠显示（思考链不刷屏）。 */
  collapsed?: boolean;
  /** 耗时（工具调用或整轮）。 */
  durationMs?: number;
}

export interface UsageTotals {
  prompt: number;
  completion: number;
  /** 最近一次调用，用于判断上下文压力。 */
  lastPrompt: number;
  /** 累计命中缓存的输入 token；端点从不上报时保持 undefined。 */
  cached: number;
  /** 是否有端点上报过缓存用量——没有上报与「命中 0」在界面上要区分。 */
  cacheReported: boolean;
}

export interface MenuItem {
  id: string;
  label: string;
  hint: string;
}

export interface MenuState {
  title: string;
  items: MenuItem[];
  index: number;
  /** 输入的过滤串（`/` 前缀的命令面板直接复用输入行内容）。 */
  filter: string;
  /** 二级选项菜单：键位提示改成「Enter 确认 | Esc 返回」。 */
  nested?: boolean;
}

export interface ApprovalPrompt {
  kind: 'approval';
  request: ApprovalRequest;
  /** 附加说明（例如 auto 模式下审查器的否决理由）。 */
  note?: string;
  resolve: (allow: boolean) => void;
}

export interface AskPrompt {
  kind: 'ask';
  question: string;
  editor: EditorState;
  resolve: (answer: string) => void;
}

export interface PlanPrompt {
  kind: 'plan';
  plan: string;
  editor: EditorState;
  resolve: (outcome: { approved: boolean; feedback?: string }) => void;
}

export type PendingPrompt = ApprovalPrompt | AskPrompt | PlanPrompt;

/** 正在执行的工具：活动区的实时指示（工具输出进滚动区之前，用户靠它知道在跑什么）。 */
export interface ActiveTool {
  name: string;
  /** 本步内的序号与已知总数（写入工具是串行发起的，total 会随后续 tool_start 增长）。 */
  index: number;
  total: number;
  startedAt: number;
}

export interface TuiState {
  phase: Phase;
  editor: EditorState;
  history: string[];
  /** 历史回溯下标；-1 表示正在编辑新内容。 */
  historyIndex: number;
  entries: TranscriptEntry[];
  usage: UsageTotals;
  model: string;
  api: string;
  effort?: string;
  approvalMode: string;
  sandboxMode: string;
  sandboxEnforcement: string;
  planMode: boolean;
  sessionId: string;
  workspaceRoot: string;
  /** 工作区目录名（状态行第一格）。 */
  projectName: string;
  /** 当前 git 分支；不在仓库里或读不到时为 undefined（状态行整格省略）。 */
  branch?: string;
  contextWindow: number;
  mcpServers: number;
  mcpTools: number;
  todo: { total: number; done: number; current?: string };
  jobs: number;
  /** 一次性提示（命令反馈、错误），由 app 决定何时清除或超时消失。 */
  notice?: Notice;
  menu?: MenuState;
  prompt?: PendingPrompt;
  /** 正在执行的工具（若有）。 */
  activeTool?: ActiveTool;
  spinner: number;
  /**
   * 回看偏移：从最新一行往上数的行数，0 表示跟随底部最新内容。
   * 全屏模式放弃了终端原生滚动历史，回看改由主循环自己实现（PgUp/PgDn）。
   */
  scroll: number;
  /** 运行中正在流式写入的 thinking 条目下标，供 thinking_end 回填正文。 */
  thinkingIndex?: number;
}

export interface TuiInit {
  model: string;
  api: string;
  effort?: string;
  approvalMode: string;
  sandboxMode: string;
  sandboxEnforcement: string;
  sessionId: string;
  workspaceRoot: string;
  contextWindow: number;
  mcpServers: number;
  mcpTools: number;
}

export function createState(init: TuiInit): TuiState {
  return {
    phase: 'idle',
    editor: emptyEditor(),
    history: [],
    historyIndex: -1,
    entries: [],
    usage: { prompt: 0, completion: 0, lastPrompt: 0, cached: 0, cacheReported: false },
    model: init.model,
    api: init.api,
    effort: init.effort,
    approvalMode: init.approvalMode,
    sandboxMode: init.sandboxMode,
    sandboxEnforcement: init.sandboxEnforcement,
    planMode: false,
    sessionId: init.sessionId,
    workspaceRoot: init.workspaceRoot,
    projectName: projectNameOf(init.workspaceRoot),
    contextWindow: init.contextWindow,
    mcpServers: init.mcpServers,
    mcpTools: init.mcpTools,
    todo: { total: 0, done: 0 },
    jobs: 0,
    spinner: 0,
    scroll: 0,
  };
}

/** 界面条目上限：条目只为「提交前」与「回放」存在，超限丢最旧的，避免长会话无界增长。 */
export const ENTRY_LIMIT = 600;

/** 工作区目录名。手写而不引 path.basename：要同时吃 Windows 的反斜杠与 POSIX 斜杠。 */
export function projectNameOf(workspaceRoot: string): string {
  const trimmed = workspaceRoot.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed || workspaceRoot;
}

export function addEntry(state: TuiState, entry: TranscriptEntry): number {  state.entries.push(entry);
  if (state.entries.length > ENTRY_LIMIT) {
    state.entries.shift();
    // 丢头会让所有下标左移一位；被跟踪的 thinking 行若本身已被丢掉，就停止跟踪，
    // 而不是把它夹到 0——那会让 thinking_end 改写一条完全无关的条目。
    if (state.thinkingIndex !== undefined) {
      state.thinkingIndex = state.thinkingIndex === 0 ? undefined : state.thinkingIndex - 1;
    }
  }
  return state.entries.length - 1;
}

/** 流式正文：续写最后一条同类型条目，否则新建。 */
export function streamEntry(state: TuiState, kind: 'assistant' | 'thinking', text: string): number {
  const last = state.entries[state.entries.length - 1];
  if (last && last.kind === kind) {
    last.text += text;
    return state.entries.length - 1;
  }
  return addEntry(state, { kind, text });
}

export function accumulateUsage(
  state: TuiState,
  promptTokens: number,
  completionTokens: number,
  cachedTokens?: number,
): void {
  state.usage.prompt += promptTokens;
  state.usage.completion += completionTokens;
  state.usage.lastPrompt = promptTokens;
  if (cachedTokens !== undefined) {
    state.usage.cached += cachedTokens;
    state.usage.cacheReported = true;
  }
}

/** 缓存命中率（0..1）；端点没上报过缓存用量时返回 undefined。 */
export function cacheHitRate(usage: UsageTotals): number | undefined {
  if (!usage.cacheReported || usage.prompt <= 0) return undefined;
  return usage.cached / usage.prompt;
}

export function todoSummary(items: readonly TodoItem[]): TuiState['todo'] {
  const done = items.filter((item) => item.status === 'completed').length;
  const current = items.find((item) => item.status === 'in_progress')?.content;
  return { total: items.length, done, current };
}

/** 按 id 找工具条目：并行调用下顺序不可靠，只能按 id 回填。 */
export function findToolEntry(state: TuiState, id: string): TranscriptEntry | undefined {
  for (let i = state.entries.length - 1; i >= 0; i--) {
    const entry = state.entries[i];
    if (entry.kind === 'tool' && entry.id === id) return entry;
  }
  return undefined;
}

/**
 * 会话消息 → 首屏回放条目。
 *
 * 工具调用与它的结果合并成一条：`assistant` 里的 toolCalls 带着入参，紧随的 `tool`
 * 消息带着结果，靠 toolCallId 配对才能既显示摘要又有正文。只有结果的调用（被中断）
 * 也保留一条，避免回放里凭空少一次调用。
 */
export function transcriptFromMessages(messages: readonly SessionMessage[]): TranscriptEntry[] {
  const resultIds = new Set<string>();
  for (const message of messages) {
    if (message.role === 'tool' && message.toolCallId) resultIds.add(message.toolCallId);
  }
  const out: TranscriptEntry[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      out.push({ kind: 'user', text: message.content });
      continue;
    }
    if (message.role === 'assistant') {
      if (message.content) out.push({ kind: 'assistant', text: message.content });
      for (const call of message.toolCalls ?? []) {
        if (resultIds.has(call.id)) continue; // 结果条目里会补上入参
        out.push(toolEntry(call.id, call.name, call.arguments, ''));
      }
      continue;
    }
    if (message.role === 'tool') {
      const id = message.toolCallId ?? '';
      const name = message.toolName ?? 'tool';
      const args = argsOf(messages, id) ?? {};
      out.push(toolEntry(id, name, args, message.content));
    }
  }
  return out;
}

function toolEntry(id: string, name: string, args: Record<string, unknown>, detail: string): TranscriptEntry {
  return {
    kind: 'tool',
    text: '',
    id,
    label: name,
    args,
    detail,
    summary: summarizeToolCall({ id, name, args, detail }),
  };
}

function argsOf(messages: readonly SessionMessage[], id: string): Record<string, unknown> | undefined {
  if (id === '') return undefined;
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      if (call.id === id) return call.arguments;
    }
  }
  return undefined;
}

/** agent 事件 → 界面条目。返回需要立刻写入滚动区的条目（流式片段请用返回值增量写）。 */
export function applyAgentEvent(state: TuiState, event: AgentEvent): void {
  switch (event.type) {
    case 'status':
      addEntry(state, { kind: 'notice', text: event.text, level: 'info' });
      break;
    case 'thinking_start':
      state.thinkingIndex = addEntry(state, { kind: 'thinking', label: event.id, text: '', collapsed: true });
      break;
    case 'thinking_end': {
      const index = state.thinkingIndex;
      if (index !== undefined && state.entries[index]) state.entries[index].text = event.content;
      state.thinkingIndex = undefined;
      break;
    }
    case 'tool_start':
      addEntry(state, {
        kind: 'tool',
        text: '',
        id: event.id,
        label: event.name,
        args: event.args,
        summary: summarizeToolCall({ id: event.id, name: event.name, args: event.args, detail: '' }),
        detail: '',
      });
      break;
    case 'tool_end': {
      const entry = findToolEntry(state, event.id);
      if (!entry) break;
      entry.ok = event.ok;
      entry.detail = event.content;
      entry.summary = summarizeToolCall({
        id: event.id,
        name: entry.label ?? event.name,
        args: entry.args ?? {},
        detail: event.content,
      });
      break;
    }
    case 'ask':
      state.notice = { text: `等待人工确认：${event.tool}`, level: 'info' };
      break;
    case 'usage':
      accumulateUsage(state, event.promptTokens, event.completionTokens, event.cachedTokens);
      break;
    case 'error':
      addEntry(state, { kind: 'error', text: event.text, level: 'error' });
      break;
    case 'text':
      streamEntry(state, 'assistant', event.text);
      break;
    case 'done':
      break;
  }
}
