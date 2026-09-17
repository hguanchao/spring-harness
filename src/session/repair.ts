/**
 * 崩溃恢复：补齐悬挂的 tool_call。
 *
 * 进程可能在「assistant 已带 toolCalls、工具还没返回」时被杀。下一轮把这段
 * 原样发给上游会被判 400。这里只追加合成 error result，不改写已提交的前缀。
 */
import { sessionEventData } from './fold.js';
import type { SessionMessage, SessionPort, SessionRecord } from './types.js';

/**
 * 工具已记录、结果未落盘：可能已有副作用，禁止盲着重试。
 * 对齐 dsh TOOL_OUTCOME_UNKNOWN。
 */
export const INTERRUPTED_TOOL =
  'The tool call was interrupted after it was recorded, but no result was durably recorded. '
  + 'Its outcome is unknown. Retry only if the operation is read-only or idempotent; '
  + 'if it may have side effects, first verify external state or ask the user. Do not retry blindly.';

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
export function repairDanglingTools(session: SessionPort, messages: SessionMessage[]): number {
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

/** 打开的 turn_start 没有对应 turn_end：崩溃尾。 */
export function hasOpenTurn(records: readonly SessionRecord[]): boolean {
  let open = 0;
  for (const record of records) {
    if (record.type !== 'event') continue;
    if (record.kind === 'turn_start') open++;
    else if (record.kind === 'turn_end' && open > 0) open--;
  }
  return open > 0;
}

/**
 * 崩溃尾：补悬挂工具结果，再关未结束的 turn。
 * 对齐 dsh interruptedTurnClosers——先 tool result，再 turn/end interrupted。
 */
export function closeInterruptedTurn(session: SessionPort, messages: SessionMessage[]): number {
  const repaired = repairDanglingTools(session, messages);
  if (!hasOpenTurn(session.readAll())) return repaired;
  session.appendEvent('turn_end', { interrupted: true, depth: 0 });
  return repaired + 1;
}
