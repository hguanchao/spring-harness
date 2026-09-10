import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs';
import { assertInsideWorkspace, fileSize, looksLikeText, READ_BYTE_LIMIT, toWorkspaceRelative } from '../workspace/boundary.js';
import { asOptionalNumber, asString, clip, type ToolContext, type ToolResult, type ToolSpec } from './types.js';

/** 单张图片上限。原图经 base64 后膨胀约 1/3，8MB 原图足以覆盖截图与设计稿。 */
const IMAGE_BYTE_LIMIT = 8 * 1024 * 1024;

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function imageMime(path: string): string | undefined {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return undefined;
  return IMAGE_MIME[path.slice(dot).toLowerCase()];
}

/**
 * 只读文件头部最多 maxBytes 字节。
 * 旧实现 readFileSync 整文件、再 subarray 截断，读一个 1GB 的日志就等于
 * 分配 1GB 内存；这里用 fd 直接限定读取长度，内存占用与文件大小解耦。
 */
function readHead(abs: string, maxBytes: number): Buffer {
  const fd = openSync(abs, 'r');
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const read = readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

export const readFileTool: ToolSpec = {
  name: 'read_file',
  description:
    'Read a file inside the workspace. Images (png/jpg/jpeg/gif/webp) are returned as attachments the model can see; text files over 100KB are truncated.',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace root' },
      offset: { type: 'integer', description: '1-based line offset (text files only)' },
      limit: { type: 'integer', description: 'Max lines to return (text files only)' },
    },
    required: ['path'],
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const rel = asString(args, 'path');
    const abs = assertInsideWorkspace(ctx.workspaceRoot, rel);
    if (!existsSync(abs)) return { ok: false, content: `file not found: ${rel}` };
    const size = fileSize(abs);
    const mime = imageMime(abs);
    if (mime) {
      if (size > IMAGE_BYTE_LIMIT) {
        return { ok: false, content: `image too large: ${rel} is ${(size / 1024 / 1024).toFixed(1)}MB (limit 8MB)` };
      }
      const dataUrl = `data:${mime};base64,${readFileSync(abs).toString('base64')}`;
      ctx.noteMemoryTouch(abs);
      return {
        ok: true,
        content: `${toWorkspaceRelative(ctx.workspaceRoot, abs)} — image attached (${(size / 1024).toFixed(0)}KB)`,
        images: [dataUrl],
      };
    }
    // 单次读盘：文本嗅探与正文切片共用同一个 Buffer，且读取长度已按上限封顶。
    const raw = readHead(abs, READ_BYTE_LIMIT);
    if (!looksLikeText(abs, raw.subarray(0, 4096))) {
      return { ok: false, content: `refused binary or non-text file: ${rel}` };
    }
    const text = raw.toString('utf8');
    const lines = text.split(/\r?\n/);
    const offset = Math.max(1, asOptionalNumber(args, 'offset') ?? 1);
    const limit = asOptionalNumber(args, 'limit');
    const sliced = limit === undefined ? lines.slice(offset - 1) : lines.slice(offset - 1, offset - 1 + limit);
    const numbered = sliced.map((line, i) => `${String(offset + i).padStart(4, ' ')}|${line}`).join('\n');
    const suffix = size > READ_BYTE_LIMIT ? `\n...[truncated at ${READ_BYTE_LIMIT} bytes of ${size}]` : '';
    ctx.noteMemoryTouch(abs);
    return { ok: true, content: `${toWorkspaceRelative(ctx.workspaceRoot, abs)}\n${clip(numbered)}${suffix}` };
  },
};
