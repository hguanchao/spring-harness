import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

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
 * 规范化到物理路径。
 *
 * 不缓存：同一轮里 `rm + mklink` 之后再用缓存，会把已经换成外链的路径当成区内文件。
 * 目标还不存在时（write 新建）对最近存在的祖先做 realpath，再拼回缺失段——否则
 * `workspace/link/new.txt`（link → 区外）会被当成区内路径。
 */
export function canonicalize(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync.native(resolved);
  } catch {
    const missing: string[] = [];
    let current = resolved;
    for (;;) {
      const parent = dirname(current);
      if (parent === current) return resolved;
      missing.unshift(basename(current));
      try {
        return resolve(realpathSync.native(parent), ...missing);
      } catch {
        current = parent;
      }
    }
  }
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

/** 单张图片上限。原图经 base64 后膨胀约 1/3，8MB 原图足以覆盖截图与设计稿。 */
export const IMAGE_BYTE_LIMIT = 8 * 1024 * 1024;

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** 按扩展名给图片定 MIME；不在 IMAGE_EXT 里的返回 undefined。 */
export function imageMime(path: string): string | undefined {
  const ext = fileExt(path);
  if (!IMAGE_EXT.has(ext)) return undefined;
  return IMAGE_MIME[ext];
}

/**
 * 只读文件头部最多 maxBytes 字节。
 * 旧实现 readFileSync 整文件、再 subarray 截断，读一个 1GB 的日志就等于
 * 分配 1GB 内存；这里用 fd 直接限定读取长度，内存占用与文件大小解耦。
 */
export function readHead(abs: string, maxBytes: number): Buffer {
  const fd = openSync(abs, 'r');
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const read = readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function utf8LeadWidth(byte: number): number {
  if ((byte & 0x80) === 0) return 1;
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
  return 1;
}

/**
 * 切开缓冲区末尾未完成的 UTF-8 序列。
 * 块边界若落在多字节字符中间，直接 toString('utf8') 会写成 U+FFFD，下一块的续字节再解码成拉丁乱码。
 */
export function splitCompleteUtf8(buf: Buffer): { complete: Buffer; rest: Buffer } {
  if (buf.length === 0) return { complete: buf, rest: buf };
  let i = buf.length;
  while (i > 0 && (buf[i - 1]! & 0xc0) === 0x80) i -= 1;
  if (i === 0) return { complete: buf, rest: Buffer.alloc(0) };
  const start = i - 1;
  const need = utf8LeadWidth(buf[start]!);
  const have = buf.length - start;
  if (need > have) return { complete: buf.subarray(0, start), rest: buf.subarray(start) };
  return { complete: buf, rest: Buffer.alloc(0) };
}
