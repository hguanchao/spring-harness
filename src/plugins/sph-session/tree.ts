import { randomBytes } from 'node:crypto';
import type { SessionMessage, SessionRecord } from '../../session/types.js';
import { messagesOf } from './query.js';

/** 短 id：本文件内唯一即可，JSONL 里也短。 */
export function newEntryId(): string {
  return randomBytes(4).toString('hex');
}

/**
 * 当前分支头：**最后一条**决定 tip 的记录——branch_tip 事件取它指向的 id，
 * 其余记录取它自己的 id。
 *
 * 单遍倒序扫描，而不是「先找 branch_tip、找不到再找最后一条带 id 的记录」：两遍写法在
 * 「`setTip` 之后又追加了记录」时会返回 setTip 的目标，把其后追加的一切从分支上抹掉。
 * 而 `append` 维护的内存 tip 是「最后追加那条的 id」，两遍写法会让**重开文件后的 tip
 * 与关机前的 tip 不一致**——恢复会话时表现为最近几轮凭空消失。
 *
 * 无 id 的旧记录跳过（v1 线性会话没有 id）。
 */
export function loadTip(records: readonly SessionRecord[]): string | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (record.type === 'event' && record.kind === 'branch_tip' && typeof record.data.id === 'string') {
      return record.data.id;
    }
    if (typeof record.id === 'string' && record.id !== '') return record.id;
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
