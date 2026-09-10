import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const READ_BYTE_LIMIT = 100 * 1024;

export class PathEscapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathEscapeError';
  }
}

/**
 * realpath 结果缓存。grep/list_dir 会对同一批文件反复调用
 * assertInsideWorkspace / toWorkspaceRelative，而 realpathSync.native 在
 * Windows 上是明显的系统调用开销（每文件 3~4 次）。
 *
 * 只缓存 realpath 成功的条目：解析失败（路径不存在）仍然每次都重算，
 * 避免把「尚未创建」的路径固化成非符号链接结果而削弱边界判定。
 */
const canonicalCache = new Map<string, string>();
const CANONICAL_CACHE_LIMIT = 4096;

export function canonicalize(path: string): string {
  const resolved = resolve(path);
  const cached = canonicalCache.get(resolved);
  if (cached !== undefined) return cached;
  let canonical: string;
  try {
    canonical = realpathSync.native(resolved);
  } catch {
    return resolved;
  }
  if (canonicalCache.size >= CANONICAL_CACHE_LIMIT) canonicalCache.clear();
  canonicalCache.set(resolved, canonical);
  return canonical;
}

function stripUnc(prefix: string): string {
  return process.platform === 'win32' ? prefix.toLowerCase() : prefix;
}

/** 工作区是安全边界：盘符、UNC、.. 一律按 realpath 判断。 */
export function assertInsideWorkspace(workspaceRoot: string, candidate: string): string {
  const root = canonicalize(workspaceRoot);
  const target = isAbsolute(candidate) ? canonicalize(candidate) : canonicalize(resolve(root, candidate));
  const rel = relative(stripUnc(root), stripUnc(target));
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new PathEscapeError(`path escapes workspace: ${candidate}`);
  }
  return target;
}

export function toWorkspaceRelative(workspaceRoot: string, absolutePath: string): string {
  const rel = relative(canonicalize(workspaceRoot), canonicalize(absolutePath));
  return rel === '' ? '.' : rel.split(sep).join('/');
}

const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.txt', '.toml',
  '.yml', '.yaml', '.xml', '.html', '.css', '.scss', '.less', '.svg', '.csv',
  '.env', '.gitignore', '.npmrc', '.editorconfig', '.rs', '.go', '.py', '.java',
  '.kt', '.kts', '.cs', '.c', '.h', '.cpp', '.hpp', '.sh', '.ps1', '.bat',
  '.sql', '.graphql', '.proto', '.lock', '.gradle', '.properties', '.ini',
]);

export function looksLikeText(path: string, sample: Buffer): boolean {
  if (sample.includes(0)) return false;
  const dot = path.lastIndexOf('.');
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : '';
  if (TEXT_EXT.has(ext)) return true;
  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.gif' || ext === '.webp' || ext === '.pdf' || ext === '.ico') {
    return false;
  }
  return sample.length === 0 || !sample.includes(0);
}

export function fileSize(path: string): number {
  return statSync(path).size;
}
