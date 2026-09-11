/**
 * 超长工具结果落盘（spill）。
 *
 * 动机：工具结果原样进上下文，一份几万字的 shell 日志或 subagent 报告会瞬间吃掉窗口，
 * 触发压缩、把真正重要的历史挤掉。这里把超阈值的结果写到磁盘，上下文里只留
 * 「头尾预览 + 绝对路径 + 取回方式」——模型需要细节时用 read_file 按 offset 读回来。
 *
 * 两个刻意的取舍：
 * 1. **只落盘、不删除**。文件按会话分目录，不定义保留策略（个人 harness 里手工清理足够），
 *    删错文件的代价远高于多占几 MB。
 * 2. **落盘失败退回原文**。spill 是优化，不是功能前提；磁盘满/只读时宁可让上下文变大，
 *    也不能让工具结果凭空消失。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 默认阈值（字符）。低于它的结果留在上下文里更划算。 */
export const DEFAULT_SPILL_THRESHOLD = 8 * 1024;
/** 预览保留的头部/尾部长度。 */
const PREVIEW_HEAD = 2000;
const PREVIEW_TAIL = 1000;

let spillSeq = 0;

export function sanitizeToolName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40);
  return cleaned === '' ? 'tool' : cleaned;
}

export class SpillStore {
  constructor(
    readonly root: string,
    readonly threshold: number = DEFAULT_SPILL_THRESHOLD,
  ) {}

  /** threshold <= 0 表示关闭 spill。 */
  get enabled(): boolean {
    return this.threshold > 0;
  }

  /**
   * 落盘并返回替换后的上下文文本。任何写入失败都返回 undefined，
   * 由调用方保留原始结果。
   */
  persist(toolName: string, text: string): string | undefined {
    if (!this.enabled || text.length <= this.threshold) return undefined;
    let path: string;
    try {
      mkdirSync(this.root, { recursive: true });
      path = join(this.root, `${sanitizeToolName(toolName)}-${Date.now().toString(36)}-${++spillSeq}.txt`);
      writeFileSync(path, text, 'utf8');
    } catch {
      return undefined;
    }
    const head = text.slice(0, PREVIEW_HEAD);
    const tail = text.slice(-PREVIEW_TAIL);
    return [
      `[spilled tool output] ${toolName}: ${text.length} chars, too large for the context.`,
      `Full text saved to: ${path}`,
      `Preview (first ${Math.min(PREVIEW_HEAD, text.length)} chars):`,
      head,
      '...',
      `Preview (last ${Math.min(PREVIEW_TAIL, text.length)} chars):`,
      tail,
      `Read more with read_file using that absolute path (offset/limit page through it).`,
    ].join('\n');
  }
}
