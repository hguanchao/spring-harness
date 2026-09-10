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

export type Phase = 'idle' | 'running' | 'approval' | 'ask' | 'plan' | 'menu' | 'status';

export interface TranscriptEntry {
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'notice' | 'error';
  text: string;
  /** 工具名或 thinking 事件 id，用于标识来源。 */
  label?: string;
  /** 工具结果的成败着色。 */
  ok?: boolean;
  /** 折叠显示（工具输出、思考链不刷屏）。 */
  collapsed?: boolean;
}

export interface UsageTotals {
  prompt: number;
  completion: number;
  /** 最近一次调用，用于判断上下文压力。 */
  lastPrompt: number;
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
  contextWindow: number;
  mcpServers: number;
  mcpTools: number;
  todo: { total: number; done: number; current?: string };
  jobs: number;
  /** 一次性提示（命令反馈、错误），下次提交或清除后消失。 */
  notice?: string;
  menu?: MenuState;
  prompt?: PendingPrompt;
  spinner: number;
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
    usage: { prompt: 0, completion: 0, lastPrompt: 0 },
    model: init.model,
    api: init.api,
    effort: init.effort,
    approvalMode: init.approvalMode,
    sandboxMode: init.sandboxMode,
    sandboxEnforcement: init.sandboxEnforcement,
    planMode: false,
    sessionId: init.sessionId,
    workspaceRoot: init.workspaceRoot,
    contextWindow: init.contextWindow,
    mcpServers: init.mcpServers,
    mcpTools: init.mcpTools,
    todo: { total: 0, done: 0 },
    jobs: 0,
    spinner: 0,
  };
}

/** 界面条目上限：条目只为「提交前」与「回放」存在，超限丢最旧的，避免长会话无界增长。 */
export const ENTRY_LIMIT = 600;

export function addEntry(state: TuiState, entry: TranscriptEntry): number {
  state.entries.push(entry);
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

export function accumulateUsage(state: TuiState, promptTokens: number, completionTokens: number): void {
  state.usage.prompt += promptTokens;
  state.usage.completion += completionTokens;
  state.usage.lastPrompt = promptTokens;
}

export function todoSummary(items: readonly TodoItem[]): TuiState['todo'] {
  const done = items.filter((item) => item.status === 'completed').length;
  const current = items.find((item) => item.status === 'in_progress')?.content;
  return { total: items.length, done, current };
}

/** 工具调用的单行摘要，避免把整段 JSON 塞进界面。 */
export function summarizeArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text === undefined) continue;
    parts.push(`${key}=${text.replace(/\s+/g, ' ').slice(0, 80)}`);
  }
  return parts.join(' ');
}

/**
 * 会话消息 → 首屏回放条目。
 * 切换会话时把历史写回滚动区，用户能看到「切过去之后聊了什么」。
 */
export function transcriptFromMessages(messages: readonly SessionMessage[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      out.push({ kind: 'user', text: message.content });
      continue;
    }
    if (message.role === 'assistant') {
      if (message.content) out.push({ kind: 'assistant', text: message.content });
      for (const call of message.toolCalls ?? []) {
        out.push({ kind: 'tool', label: call.name, text: summarizeArgs(call.arguments) });
      }
      continue;
    }
    if (message.role === 'tool') {
      out.push({ kind: 'tool', label: message.toolName ?? 'tool', text: message.content, ok: true, collapsed: true });
    }
  }
  return out;
}

/** agent 事件 → 界面条目。返回需要立刻写入滚动区的条目（流式片段请用返回值增量写）。 */
export function applyAgentEvent(state: TuiState, event: AgentEvent): void {
  switch (event.type) {
    case 'status':
      addEntry(state, { kind: 'notice', text: event.text });
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
        label: event.name,
        text: summarizeArgs(event.args),
        collapsed: true,
      });
      break;
    case 'tool_end': {
      addEntry(state, { kind: 'tool', label: `${event.name} 结果`, text: event.content, ok: event.ok, collapsed: true });
      break;
    }
    case 'ask':
      state.notice = `等待人工确认：${event.tool}`;
      break;
    case 'usage':
      accumulateUsage(state, event.promptTokens, event.completionTokens);
      break;
    case 'error':
      addEntry(state, { kind: 'error', text: event.text });
      break;
    case 'text':
      streamEntry(state, 'assistant', event.text);
      break;
    case 'done':
      break;
  }
}
