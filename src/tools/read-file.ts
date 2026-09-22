import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import {
  assertInsideWorkspace,
  canonicalize,
  IMAGE_BYTE_LIMIT,
  imageMime,
  isStrictChildRel,
  looksLikeText,
  READ_BYTE_LIMIT,
  readHead,
  splitCompleteUtf8,
  TEXT_SNIFF_BYTES,
  toWorkspaceRelative,
} from '../workspace/boundary.js';
import { asOptionalNumber, asString, clip, type ToolContext, type ToolResult, type ToolSpec } from './types.js';

const SCAN_CHUNK = 64 * 1024;

/**
 * 从第 offset 行（1-based）开始读取最多 limit 行 / maxBytes 字节。
 *
 * 旧实现永远从 position 0 读文件头再按行号切片，于是 offset 落在那 100KB 之后时
 * 「成功返回空内容」——调用方以为文件只有这么长。这里按块顺序扫描、只保留窗口内的行，
 * 内存有界（不整文件读入），代价是仍需从头跳过前面的字节——没有行索引时这是不可避免的。
 */
function readLineWindow(
  abs: string,
  offset: number,
  limit: number | undefined,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const fd = openSync(abs, 'r');
  try {
    const chunk = Buffer.allocUnsafe(SCAN_CHUNK);
    const collected: string[] = [];
    let collectedBytes = 0;
    let line = 1;
    let carry = '';
    let pending: Buffer = Buffer.alloc(0);
    let truncated = false;
    let done = false;
    for (;;) {
      const read = readSync(fd, chunk, 0, SCAN_CHUNK, null);
      if (read === 0) break;
      const { complete, rest } = splitCompleteUtf8(Buffer.concat([pending, chunk.subarray(0, read)]));
      pending = rest;
      const parts = (carry + complete.toString('utf8')).split('\n');
      // 最后一段可能被块边界劈开，留给下一轮；只有 EOF 时它才是真正的一行。
      carry = parts.pop() ?? '';
      for (const part of parts) {
        if (line >= offset) {
          const value = part.endsWith('\r') ? part.slice(0, -1) : part;
          collected.push(value);
          collectedBytes += value.length + 1;
          if (limit !== undefined && collected.length >= limit) {
            done = true;
            break;
          }
          if (collectedBytes >= maxBytes) {
            truncated = true;
            done = true;
            break;
          }
        }
        line++;
      }
      if (done) break;
    }
    if (!done && pending.length > 0) {
      carry += pending.toString('utf8');
      pending = Buffer.alloc(0);
    }
    // 文件不以换行结尾时，carry 里还留着最后一行。
    if (!done && carry !== '' && line >= offset && (limit === undefined || collected.length < limit)) {
      collected.push(carry.endsWith('\r') ? carry.slice(0, -1) : carry);
    }
    return { text: collected.join('\n'), truncated };
  } finally {
    closeSync(fd);
  }
}

/**
 * 解析读取目标。
 *
 * 默认只允许工作区内路径；额外放行 spill 根内的绝对路径——spill 文件按设计落在
 * `~/.sph/spill/`（工作区之外），如果这里不放行，模型拿到 locator 也读不回来，
 * spill 就只是「把内容丢掉」而不是「把内容挪走」。
 */
function resolveReadTarget(workspaceRoot: string, path: string, spillRoot?: string): string {
  if (spillRoot && isAbsolute(path)) {
    const root = canonicalize(spillRoot);
    const target = canonicalize(path);
    if (isStrictChildRel(relative(root, target))) return target;
  }
  return assertInsideWorkspace(workspaceRoot, path);
}

export const readFileTool: ToolSpec = {
  name: 'read',
  description:
    'Use this — not shell cat, head, or tail — to inspect a file inside the workspace.'
    + ' Images (png/jpg/jpeg/gif/webp) come back as attachments you can see.'
    + ' Text is read in windows: use offset (1-based line) and limit to page through a large file'
    + ' rather than assuming the file ends where the window does.',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace root, or an absolute path under the spill directory' },
      offset: { type: 'integer', description: '1-based line offset (text files only)' },
      limit: { type: 'integer', description: 'Max lines to return (text files only)' },
    },
    required: ['path'],
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const rel = asString(args, 'path');
    const abs = resolveReadTarget(ctx.workspaceRoot, rel, ctx.spillRoot);
    if (!existsSync(abs)) return { ok: false, content: `file not found: ${rel}` };
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      return { ok: false, content: `not a file: ${rel} (it is a directory — use ls)` };
    }
    const size = stat.size;
    const mime = imageMime(abs);
    if (mime) {
      if (size > IMAGE_BYTE_LIMIT) {
        return { ok: false, content: `image too large: ${rel} is ${(size / 1024 / 1024).toFixed(1)}MB (limit 8MB)` };
      }
      const dataUrl = `data:${mime};base64,${readFileSync(abs).toString('base64')}`;
      ctx.noteMemoryTouch(abs);
      ctx.observation?.noteRead(abs);
      return {
        ok: true,
        content: `${toWorkspaceRelative(ctx.workspaceRoot, abs)} — image attached (${(size / 1024).toFixed(0)}KB)`,
        images: [dataUrl],
      };
    }
    // 嗅探只取文件头 4KB；正文由 readLineWindow 按行窗口读取，
    // 因此 offset 落在 100KB 之后也能取到内容，而不是静默返回空。
    const head = readHead(abs, TEXT_SNIFF_BYTES);
    if (!looksLikeText(abs, head)) {
      return { ok: false, content: `refused binary or non-text file: ${rel}` };
    }
    const offset = Math.max(1, asOptionalNumber(args, 'offset') ?? 1);
    const limit = asOptionalNumber(args, 'limit');
    const window = readLineWindow(abs, offset, limit, READ_BYTE_LIMIT);
    if (window.text === '' && offset > 1) {
      return { ok: true, content: `${toWorkspaceRelative(ctx.workspaceRoot, abs)}\n(no content at line ${offset}: the file has fewer lines)` };
    }
    const lines = window.text === '' ? [] : window.text.split('\n');
    const numbered = lines.map((line, i) => `${String(offset + i).padStart(4, ' ')}|${line}`).join('\n');
    const suffix = window.truncated ? `\n...[truncated at ${READ_BYTE_LIMIT} bytes from line ${offset}]` : '';
    ctx.noteMemoryTouch(abs);
    ctx.observation?.noteRead(abs);
    return { ok: true, content: `${toWorkspaceRelative(ctx.workspaceRoot, abs)}\n${clip(numbered)}${suffix}` };
  },
};
