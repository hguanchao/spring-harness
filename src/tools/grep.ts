import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { assertInsideWorkspace, looksLikeText, toWorkspaceRelative } from '../workspace/boundary.js';
import { asString, clip, type ToolContext, type ToolResult, type ToolSpec } from './types.js';

const SKIP = new Set(['node_modules', '.git', 'dist', '.sph']);
/** 命中上限，达到即停止遍历，避免在巨型仓库里扫完整棵树。 */
const HIT_LIMIT = 200;
/** 目录递归深度上限，防符号链接环与超深目录导致栈溢出。 */
const MAX_DEPTH = 24;
/** 文本嗅探字节数；不文本直接跳过，不再整文件读进内存。 */
const SNIFF_BYTES = 4096;

function walk(dir: string, files: string[], depth = 0): void {
  if (depth > MAX_DEPTH) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walk(full, files, depth + 1);
    else files.push(full);
  }
}

/**
 * 先嗅探头部 4KB 判定文本，命中才把正文读进来。
 * 旧实现无条件 readFileSync 整个文件再判定，仓库里的图片/压缩包/构建产物
 * 会被完整读进内存后立刻丢弃——大仓库里这是主要的内存与 I/O 开销。
 */
function looksTextual(file: string): boolean {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return false;
  }
  try {
    const head = Buffer.allocUnsafe(SNIFF_BYTES);
    const read = readSync(fd, head, 0, SNIFF_BYTES, 0);
    return looksLikeText(file, head.subarray(0, read));
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

/** 按行遍历但不构造整表行数组：文件只需一份字符串副本，行是切片视图。 */
function scanLines(text: string, visit: (line: string, lineNo: number) => boolean): void {
  let lineStart = 0;
  let lineNo = 1;
  for (let i = 0; i <= text.length; i++) {
    if (i !== text.length && text.charCodeAt(i) !== 10) continue;
    const end = i > lineStart && text.charCodeAt(i - 1) === 13 ? i - 1 : i;
    if (!visit(text.slice(lineStart, end), lineNo)) return;
    lineNo++;
    lineStart = i + 1;
  }
}

export const grepTool: ToolSpec = {
  name: 'grep',
  description: 'Search file contents in the workspace with a JavaScript regular expression.',
  schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string', description: 'Optional subdirectory or file, relative to workspace' },
    },
    required: ['pattern'],
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const pattern = asString(args, 'pattern');
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'm');
    } catch {
      return { ok: false, content: `invalid regex: ${pattern}` };
    }
    const startRel = typeof args.path === 'string' && args.path.length > 0 ? args.path : '.';
    const start = assertInsideWorkspace(ctx.workspaceRoot, startRel);
    if (!existsSync(start)) return { ok: false, content: `path not found: ${startRel}` };
    const files: string[] = [];
    const startStat = statSync(start);
    if (startStat.isFile()) files.push(start);
    else walk(start, files);
    const hits: string[] = [];
    outer: for (const file of files) {
      if (!looksTextual(file)) continue;
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const rel = toWorkspaceRelative(ctx.workspaceRoot, file);
      scanLines(text, (line, lineNo) => {
        if (regex.test(line)) {
          hits.push(`${rel}:${lineNo}:${line}`);
          // 单文件内也要封顶，否则一个巨型文件就能越过上限。
          return hits.length < HIT_LIMIT;
        }
        return true;
      });
      if (hits.length >= HIT_LIMIT) break outer;
    }
    if (hits.length === 0) return { ok: true, content: 'no matches' };
    return { ok: true, content: clip(hits.join('\n')) };
  },
};
