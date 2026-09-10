import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { sphSessionsRoot } from '../home.js';
import { canonicalize } from '../workspace/boundary.js';

/** 按规范工作区路径编码，避免盘符和斜杠进目录名。 */
export function encodeWorkspaceKey(workspaceRoot: string): string {
  const canonical = canonicalize(workspaceRoot);
  const digest = createHash('sha256').update(canonical.toLowerCase()).digest('hex').slice(0, 16);
  const leaf = canonical.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) ?? 'ws';
  const safeLeaf = leaf.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 32);
  return `${safeLeaf}-${digest}`;
}

export function sessionDirFor(workspaceRoot: string): string {
  return join(sphSessionsRoot(), encodeWorkspaceKey(workspaceRoot));
}
