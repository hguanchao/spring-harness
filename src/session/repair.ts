/**
 * 崩溃恢复：补齐悬挂的 tool_call。
 *
 * 进程可能在「assistant 已带 toolCalls、工具还没返回」时被杀。下一轮把这段
 * 原样发给上游会被判 400。这里只追加合成 error result，不改写已提交的前缀。
 */
import { sessionEventData } from './fold.js';
import type { JsonlSession } from './store.js';
import type { SessionMessage } from './types.js';

export const INTERRUPTED_TOOL = 'interrupted (session resumed before tool completed)';

export interface DanglingToolCall {
  id: string;
  name: string;
}

/** 扫一遍消息：assistant 发出的 toolCallId 若后面没有对应 tool 消息，即悬挂。 */
export function findDanglingToolCalls(messages: readonly SessionMessage[]): DanglingToolCall[] {
  const pending = new Map<string, string>();
  for (const row of messages) {
    if (row.role === 'assistant' && row.toolCalls) {
      for (const call of row.toolCalls) pending.set(call.id, call.name);
    }
    if (row.role === 'tool' && row.toolCallId) pending.delete(row.toolCallId);
  }
  const out: DanglingToolCall[] = [];
  for (const [id, name] of pending) out.push({ id, name });
  return out;
}

/**
 * 把悬挂的 tool_call 写成 tool 消息 + 失败事件，并同步推进 `messages` 镜像。
 * 返回补了几条；完整配对时为零。
 */
export function repairDanglingTools(session: JsonlSession, messages: SessionMessage[]): number {
  const dangling = findDanglingToolCalls(messages);
  for (const call of dangling) {
    session.appendMessage({
      role: 'tool',
      content: INTERRUPTED_TOOL,
      toolCallId: call.id,
      toolName: call.name,
    });
    session.appendEvent('tool_result', sessionEventData.toolFailure(call.name, INTERRUPTED_TOOL));
    messages.push({
      type: 'message',
      ts: new Date().toISOString(),
      role: 'tool',
      content: INTERRUPTED_TOOL,
      toolCallId: call.id,
      toolName: call.name,
    });
  }
  return dangling.length;
}
