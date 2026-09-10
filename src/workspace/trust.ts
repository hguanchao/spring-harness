import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative } from 'node:path';
import { sphTrustedPath } from '../home.js';
import { canonicalize } from './boundary.js';

/**
 * 工作区信任：AGENTS.md / skills 会进模型上下文，工具会在该目录读写与执行。
 * 未确认前不跑 agent。祖先目录信任覆盖子孙；子目录信任不回升到父目录。
 */

interface TrustedFile {
  workspaces: string[];
}

function norm(path: string): string {
  const canonical = canonicalize(path);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/** trustedRoot 等于 workspace，或 workspace 落在 trustedRoot 之内。 */
function covers(trustedRoot: string, workspace: string): boolean {
  const root = norm(trustedRoot);
  const ws = norm(workspace);
  if (ws === root) return true;
  const rel = relative(root, ws);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function readTrustedFile(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    const workspaces = (parsed as TrustedFile).workspaces;
    if (!Array.isArray(workspaces)) return [];
    return workspaces.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
  } catch {
    // 坏文件当未信任，fail-closed。
    return [];
  }
}

function writeTrustedFile(filePath: string, workspaces: string[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const body = `${JSON.stringify({ workspaces } satisfies TrustedFile, null, 2)}\n`;
  writeFileSync(filePath, body, 'utf8');
}

export function isWorkspaceTrusted(workspaceRoot: string, filePath = sphTrustedPath()): boolean {
  const canonical = canonicalize(workspaceRoot);
  return readTrustedFile(filePath).some((root) => covers(root, canonical));
}

/** 记下当前工作区根。已被祖先覆盖则不写重复项。 */
export function rememberTrustedWorkspace(workspaceRoot: string, filePath = sphTrustedPath()): void {
  const canonical = canonicalize(workspaceRoot);
  const current = readTrustedFile(filePath);
  if (current.some((root) => covers(root, canonical))) return;
  writeTrustedFile(filePath, [...current, canonical]);
}
