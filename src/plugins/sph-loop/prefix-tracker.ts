/**
 * 请求前缀的分段变更观测。
 *
 * 为什么需要它：`cache_miss`（llm/cache-stats.ts）只能告诉你「这一轮少命中了多少」，
 * 却说不清**哪一段变了**。前缀按 `tools → system → messages` 拼接，三段的变更原因、
 * 频率与治理方式完全不同——tools 变来自工具表，system 变来自工具说明或角色约束，
 * messages 中段分叉则说明 append-only 被破坏。日期、技能目录、指令文件在尾部消息里，
 * 变了只是追加，不该报成 system 变化。
 * 逐段 hash 对比把「缓存为什么变差」从猜测变成一条会话事件。
 *
 * 口径：合法形态是**纯追加**——上一轮请求的消息序列是本轮请求消息序列的前缀。此时
 * 上一轮请求的每个字节都还活在本轮前缀里，缓存应完整命中。其余任何形态（中段分叉、
 * 头部变化）都值得记录。
 */

import { createHash } from 'node:crypto';

export type PrefixSegment = 'tools' | 'system' | 'messages';

export interface PrefixSnapshot {
  toolsHash: string;
  systemHash: string;
  /** 按序的逐条消息 hash；长度为 0 表示本轮请求没有消息（理论边界）。 */
  messageHashes: readonly string[];
}

export interface PrefixChange {
  segment: PrefixSegment;
  /** messages 段从第几条（0 基）开始与上一轮不同；tools / system 段无此字段。 */
  fromIndex?: number;
}

/** 短 hash：事件里可读即可，不做安全用途。 */
export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * 单条消息的 hash 输入截断到 8KB：hash 的目的是**检测变更**，不是内容指纹——
 * 截断以内的变化都能发现；超长尾部（几乎全是模型生成的长文本）变了也不影响
 * 前缀结论，因为分叉检测只需要逐条等值，不需要抗碰撞。
 */
const MESSAGE_HASH_INPUT_LIMIT = 8192;

export function hashMessage(message: object): string {
  const body = JSON.stringify(message) ?? '';
  return hashText(body.length > MESSAGE_HASH_INPUT_LIMIT ? body.slice(0, MESSAGE_HASH_INPUT_LIMIT) : body);
}

/**
 * 与上一轮快照对比，返回变更段列表（空数组 = 纯追加或完全一致）。
 *
 * messages 段只在**中段分叉**时报：上一轮的某一条在下一轮变了位置或内容。尾部追加
 * （合法）与完全一致都不报——报出来全是噪声。tools / system 一变就报，它们本该是
 * 会话内的常量。
 */
export function observePrefix(prev: PrefixSnapshot | undefined, next: PrefixSnapshot): PrefixChange[] {
  if (prev === undefined) return [];
  const changes: PrefixChange[] = [];
  if (prev.toolsHash !== next.toolsHash) changes.push({ segment: 'tools' });
  if (prev.systemHash !== next.systemHash) changes.push({ segment: 'system' });
  const shared = Math.min(prev.messageHashes.length, next.messageHashes.length);
  let diverged = -1;
  for (let i = 0; i < shared; i++) {
    if (prev.messageHashes[i] !== next.messageHashes[i]) {
      diverged = i;
      break;
    }
  }
  if (diverged >= 0) {
    changes.push({ segment: 'messages', fromIndex: diverged });
  } else if (prev.messageHashes.length > next.messageHashes.length) {
    // 尾部收缩：上一轮请求的尾部消息在本轮前缀里消失了。到达这里的收缩都是非计划的
    // （compact 走单独的重置路径），对 append-only 的破坏同样值得记录。
    changes.push({ segment: 'messages', fromIndex: next.messageHashes.length });
  }
  return changes;
}
