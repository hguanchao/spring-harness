import type { SessionMessage, SessionRecord } from './types.js';

/** 会话记录 → 消息。单遍收集，避免 readAll().filter() 的中间数组与类型谓词。 */
export function messagesOf(records: readonly SessionRecord[]): SessionMessage[] {
  const out: SessionMessage[] = [];
  for (const record of records) {
    if (record.type === 'message') out.push(record);
  }
  return out;
}

/**
 * 会话读模型：从记录尾部取最后一条 assistant 正文。
 * 旧写法 `[...messages].reverse().find(...)` 会为一次查找复制整个消息数组，
 * 长会话下是白白的 O(n) 内存与分配。
 */
export function lastAssistantMessage(messages: readonly SessionMessage[]): SessionMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const row = messages[i];
    if (row.role === 'assistant') return row;
  }
  return undefined;
}
