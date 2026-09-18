import { relative } from 'node:path';
import { casefoldPath, canonicalize, isStrictChildRel } from './boundary.js';
import { addTrustedWorkspace, readState } from '../config/state.js';
import { sphConfigPath } from '../home.js';

/**
 * 工作区信任：AGENTS.md / skills 会进模型上下文，工具会在该目录读写与执行。
 * 未确认前不跑 agent。祖先目录信任覆盖子孙；子目录信任不回升到父目录。
 *
 * 存储在 config.toml 的顶层 `trusted` 数组——信任是用户对安全边界的意图，与 sandbox /
 * approval 同属一类，不再散落成单独的 JSON 文件。
 */

function norm(path: string): string {
  return casefoldPath(canonicalize(path));
}

/** trustedRoot 等于 workspace，或 workspace 落在 trustedRoot 之内。 */
function covers(trustedRoot: string, workspace: string): boolean {
  const root = norm(trustedRoot);
  const ws = norm(workspace);
  if (ws === root) return true;
  return isStrictChildRel(relative(root, ws));
}

export function isWorkspaceTrusted(workspaceRoot: string, filePath: string = sphConfigPath()): boolean {
  const canonical = canonicalize(workspaceRoot);
  return readState(filePath).trusted.some((root) => covers(root, canonical));
}

/** 记下当前工作区根。已被祖先覆盖则不写重复项。 */
export function rememberTrustedWorkspace(workspaceRoot: string, filePath: string = sphConfigPath()): void {
  const canonical = canonicalize(workspaceRoot);
  const state = readState(filePath);
  if (state.trusted.some((root) => covers(root, canonical))) return;
  addTrustedWorkspace(canonical, filePath);
}
