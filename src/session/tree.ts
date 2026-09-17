import { randomBytes } from 'node:crypto';
import type { SessionMessage, SessionRecord } from './types.js';
import { messagesOf } from './query.js';

/** 短 id：和 pi 一样够本文件内唯一，JSONL 里也短。 */
export function newEntryId(): string {
  return randomBytes(4).toString('hex');
}

/** 当前分支头：优先最近一次 branch_tip 事件，否则最后一条带 id 的记录。 */
export function loadTip(records: readonly SessionRecord[]): string | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (record.type === 'event' && record.kind === 'branch_tip' && typeof record.data.id === 'string') {
      return record.data.id;
    }
  }
  for (let i = records.length - 1; i >= 0; i--) {
    const id = records[i]?.id;
    if (id) return id;
  }
  return undefined;
}

/**
 * 从 tip 沿 parentId 走到根。没有 id 的旧记录视为线性前缀，始终保留。
 * 弃枝仍在文件里，只是不在这条路上。
 */
export function lineage(records: readonly SessionRecord[], tip?: string): SessionRecord[] {
  const indexed = records.filter((record): record is SessionRecord & { id: string } => typeof record.id === 'string');
  if (indexed.length === 0) return [...records];
  const byId = new Map(indexed.map((record) => [record.id, record]));
  const start = tip && byId.has(tip) ? tip : indexed[indexed.length - 1]!.id;
  const chain: SessionRecord[] = [];
  const seen = new Set<string>();
  let current: string | undefined = start;
  while (current && !seen.has(current)) {
    seen.add(current);
    const row = byId.get(current);
    if (!row) break;
    chain.push(row);
    current = row.parentId ?? undefined;
  }
  chain.reverse();
  const legacy = records.filter((record) => record.id === undefined);
  return [...legacy, ...chain];
}

export function messagesOnPath(records: readonly SessionRecord[], tip?: string): SessionMessage[] {
  return messagesOf(lineage(records, tip));
}
