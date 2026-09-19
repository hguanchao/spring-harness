/**
 * 会话记录 → 界面的回放投影。
 *
 * resume / 切换会话时把 JSONL 记录（消息 + 事件）重放回 UI：消息建块，事件恢复
 * 跨轮次状态（模型选择、用量、标题、recap、子代理行）。与实时路径共用同一套投影
 * （TranscriptProjection），回放出的时间线与直播时逐块一致。
 *
 * 状态落位（goal/失败/计划模式/水印/深度/模型/标题）经宿主回调写入——这些字段归
 * 交互模式所有，回放只负责「从记录里读出来」。
 */

import { isSessionStateMessage } from '../agent/prompt.js';
import { messagesOf } from '../session/query.js';
import { closeInterruptedTurn } from '../session/repair.js';
import { foldSessionState, type SessionFailure } from '../session/fold.js';
import type { SessionMessage, SessionRecord } from '../session/types.js';
import type { JsonlSession } from '../session/store.js';
import type { CustomEditor } from './components/custom-editor.js';
import { AssistantMessageComponent } from './components/assistant-message.js';
import { UserMessageComponent } from './components/user-message.js';
import type { VStack } from './core/index.js';
import { getMarkdownTheme } from './theme/theme.js';
import type { TranscriptProjection } from './transcript.js';

/** 回放需要的宿主能力：容器、投影与状态落位回调。 */
export interface ReplayHost {
  session: JsonlSession;
  /** 会话发过的用户指令回放进输入历史（↑ 翻找重发）。 */
  editor: Pick<CustomEditor, 'addToHistory'>;
  /** 与实时路径共用的转录投影（工具行/分组/子代理行）。 */
  projection: TranscriptProjection;
  /** 聊天流容器（用户块/助手块挂进来）。 */
  chatContainer: VStack;
  addNotice(text: string, level?: 'dim' | 'warn' | 'error' | 'success'): void;
  /** 把一行 recap 摘要挂进对话流。 */
  addRecap(summary: string): void;
  applyEditorBorder(): void;
  /** 把最新一条用户消息钉在转录顶。 */
  pinLatestUserMessage(): void;
  /** 折叠出的跨轮次状态落位。 */
  applyFoldedState(state: {
    goal?: string;
    lastFailure?: SessionFailure;
    planMode: boolean;
    lastRecapMainTurn: number;
    depth: number;
  }): void;
  /** model_selection 事件落位：本进程后续请求按它发。 */
  applyReplayedModel(model: string, contextWindow?: number, maxTokens?: number): void;
  /** usage 事件：与实时路径共用同一套累计逻辑。 */
  applyUsage(data: Record<string, unknown>): void;
  /** title 事件落位：tab 常驻名，resume 直接接续，不重新生成。 */
  applySessionTitle(title: string): void;
}

/**
 * 恢复会话：修回合被中断的轮次、回放全部记录、恢复输入历史。
 * 空会话直接返回（打开即退不产生噪音）。
 */
export function restoreSessionInto(host: ReplayHost): void {
  let records = host.session.readAll();
  if (records.length === 0) return;
  const messages = messagesOf(records);
  if (closeInterruptedTurn(host.session, messages) > 0) records = host.session.readAll();

  const view = host.session.readPath();
  replayRecords(host, view.length > 0 ? view : records);
  restorePromptHistory(host, messagesOf(records));
  host.applyEditorBorder();
  host.pinLatestUserMessage();
  const messageCount = messagesOf(records).length;
  if (messageCount > 0) {
    host.addNotice(`Resumed session ${host.session.id} · ${messageCount} messages`, 'dim');
  }
}

/**
 * 会话发过的用户指令回放进输入历史（grok 的 prompt_history 语义：会话级、最新在前）。
 * 恢复会话（-c / --resume）后按 ↑ 就能翻出上次发过的指令，改了直接重发。
 * 过滤：斜杠命令、以 '[' 开头的系统合成消息（[session state] / [steering] / [background
 * task] 等，非用户原文）、超长上下文倾倒——回放的是「指令」，不是消息存档。
 */
function restorePromptHistory(host: ReplayHost, messages: readonly SessionMessage[]): void {
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const content = message.content.trim();
    if (content === '' || content.startsWith('/') || content.startsWith('[')) continue;
    if (content.length > 2000) continue;
    const ts = Number.isNaN(Date.parse(message.ts)) ? Date.now() : Date.parse(message.ts);
    host.editor.addToHistory(content, ts);
  }
}

function replayRecords(host: ReplayHost, records: readonly SessionRecord[]): void {
  const folded = foldSessionState(records);
  host.applyFoldedState({
    goal: folded.goal,
    lastFailure: folded.failures.at(-1),
    planMode: folded.planMode,
    lastRecapMainTurn: folded.lastRecapMainTurn,
    depth: folded.depth,
  });

  for (const record of records) {
    if (record.type === 'message') {
      replayMessage(host, record);
      continue;
    }
    replayEvent(host, record.kind, record.data);
  }
}

function replayMessage(host: ReplayHost, record: SessionMessage): void {
  if (record.role === 'user') {
    // 跨轮次状态快照（goal/失败/计划模式）是给模型读的缓存友好注入，不进聊天流——
    // 每轮一条的重复快照在回放里只会是噪声；最新一条的语义已由当前 turn 的注入保证。
    if (isSessionStateMessage(record.content)) return;
    host.chatContainer.addChild(new UserMessageComponent(record.content, getMarkdownTheme()));
    return;
  }
  if (record.role === 'assistant') {
    // 空文本的纯工具回复不建组件、也不打断分组：与实时路径一致——只有真正的
    // 回答文本才把工具 run 切开，多个纯工具回复的工具仍并进同一组。
    if (record.content !== '') {
      host.projection.breakToolGroup();
      const component = new AssistantMessageComponent({ markdownTheme: getMarkdownTheme() });
      component.setText(record.content);
      host.chatContainer.addChild(component);
    }
    for (const call of record.toolCalls ?? []) {
      host.projection.beginReplayedTool(call.name, call.id, call.arguments);
    }
    return;
  }
  if (record.role === 'tool') {
    host.projection.replayToolResult(record.toolCallId, record.toolName, record.content);
  }
}

function replayEvent(host: ReplayHost, kind: string, data: Record<string, unknown>): void {
  if (kind === 'model_selection' && typeof data.model === 'string') {
    const contextWindow = typeof data.contextWindow === 'number' ? data.contextWindow : undefined;
    const maxTokens = typeof data.maxTokens === 'number' ? data.maxTokens : undefined;
    host.applyReplayedModel(data.model, contextWindow, maxTokens);
    return;
  }
  if (kind === 'usage') {
    host.applyUsage(data);
    return;
  }
  if (kind === 'title') {
    // 会话标题：tab 常驻名，resume 直接接续，不重新烧一次生成调用。
    if (typeof data.title === 'string' && data.title !== '') host.applySessionTitle(data.title);
    return;
  }
  if (kind === 'recap') {
    // 未上屏的 recap（自动长尾输出）只留档，回放时跳过——否则用户会在恢复后
    // 看到一条当时被刻意压下去的跑飞摘要。
    if (data.shown === false) return;
    const summary = typeof data.summary === 'string' ? data.summary : '';
    if (summary !== '') host.addRecap(summary);
    return;
  }
  if (kind === 'subagent' && data.phase === 'start') {
    const id = typeof data.id === 'string' ? data.id : '';
    const description = typeof data.description === 'string' ? data.description : '';
    const toolCallId = typeof data.toolCallId === 'string' ? data.toolCallId : undefined;
    const childType = typeof data.childType === 'string' ? data.childType : undefined;
    // 回放与实时路径同构：按 toolCallId 归位到 Task 工具行。
    const attached = host.projection.attachReplayedSubagent({ id, description, toolCallId, childType, background: data.mode === 'background' });
    if (!attached) host.addNotice(`subagent · ${description}`, 'dim');
    return;
  }
  if (kind === 'subagent' && data.phase === 'end') {
    const ok = data.ok === true;
    const durationMs = typeof data.durationMs === 'number' && Number.isFinite(data.durationMs) ? data.durationMs : 0;
    const summary = typeof data.summary === 'string' ? data.summary : '';
    const tokens = typeof data.tokens === 'number' && Number.isFinite(data.tokens) ? data.tokens : undefined;
    if (!host.projection.finishSubagent(typeof data.id === 'string' ? data.id : '', ok, durationMs, summary, tokens)) {
      host.addNotice(`subagent · ${ok ? 'done' : 'FAILED'}`, ok ? 'dim' : 'error');
    }
  }
}
