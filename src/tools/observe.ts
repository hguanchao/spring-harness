/**
 * 本轮已读/已写路径。对齐 dsh fs-observation-policy：覆盖或编辑已存在文件前必须先读过。
 * 不落盘——resume 后要重新读。本轮内 write 新建的文件记为已观察，随后 search_replace 不必再读。
 */
import { existsSync } from 'node:fs';
import { canonicalize, casefoldPath } from '../workspace/boundary.js';
import type { ToolResult } from './types.js';

export const NOT_OBSERVED =
  'cannot modify: file has not been read — read the file, then retry';

export class FileObservation {
  private readonly seen = new Set<string>();

  private key(abs: string): string {
    return casefoldPath(canonicalize(abs));
  }

  noteRead(abs: string): void {
    this.seen.add(this.key(abs));
  }

  noteWritten(abs: string): void {
    this.seen.add(this.key(abs));
  }

  /** 已存在且未见过：拒绝。不存在则允许创建。 */
  denyIfUnseen(abs: string): ToolResult | undefined {
    if (!existsSync(abs)) return undefined;
    if (this.seen.has(this.key(abs))) return undefined;
    return { ok: false, content: NOT_OBSERVED };
  }
}
