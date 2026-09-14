import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const READ_BYTE_LIMIT = 100 * 1024;
/** 文本嗅探只读文件头这么多字节：够判 NUL / 常见魔数，不必整文件进内存。 */
export const TEXT_SNIFF_BYTES = 4096;

/** 相对路径是否逃出根（`..` 或另一条绝对路径）。 */
export function pathEscapes(rel: string): boolean {
  return rel.startsWith('..') || isAbsolute(rel);
}

/** 相对路径落在根之下（不含根自身）。 */
export function isStrictChildRel(rel: string): boolean {
  return rel !== '' && !pathEscapes(rel);
}

/** Windows 上路径比较忽略大小写；其它平台保持原串。 */
export function casefoldPath(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

export function fileExt(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot >= 0 ? path.slice(dot).toLowerCase() : '';
}

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

/** 工作区是安全边界：盘符、UNC、.. 一律按 realpath 判断。 */
export function assertInsideWorkspace(workspaceRoot: string, candidate: string): string {
  const root = canonicalize(workspaceRoot);
  const target = isAbsolute(candidate) ? canonicalize(candidate) : canonicalize(resolve(root, candidate));
  const rel = relative(casefoldPath(root), casefoldPath(target));
  if (pathEscapes(rel)) {
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

/** 明确按图片附件处理的扩展名；looksLikeText 与 read_file 共用，避免一边漏登记。 */
export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const NON_TEXT_EXT = new Set(['.pdf', '.ico', ...IMAGE_EXT]);

export function looksLikeText(path: string, sample: Buffer): boolean {
  if (sample.includes(0)) return false;
  const ext = fileExt(path);
  if (TEXT_EXT.has(ext)) return true;
  if (NON_TEXT_EXT.has(ext)) return false;
  return true;
}

export function fileSize(path: string): number {
  return statSync(path).size;
}
