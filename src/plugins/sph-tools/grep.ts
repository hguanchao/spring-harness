import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { assertInsideWorkspace, looksLikeText, TEXT_SNIFF_BYTES, toWorkspaceRelative } from '../../workspace/boundary.js';
import { asString, clip, type ToolContext, type ToolResult, type ToolSpec } from '../../tools/types.js';

const SKIP = new Set(['node_modules', '.git', 'dist', '.sph']);
/** 命中上限，达到即停止遍历，避免在巨型仓库里扫完整棵树。 */
const HIT_LIMIT = 200;
/** 目录递归深度上限，防符号链接环与超深目录导致栈溢出。 */
const MAX_DEPTH = 24;

/**
 * 递归收集候选文件。
 *
 * **符号链接一律不下探**：`statSync` 会跟随链接，工作区里一个指向外部目录的软链接（或
 * Windows 目录联接）就等于给 grep 开了一条把工作区外的文件读进上下文的路。glob 一直这么
 * 做（见 glob.ts 的 `entry.isSymbolicLink()`），这里此前漏了，是本项目唯一能读出工作区外的读取路径。
 *
 * 用 `withFileTypes` 取目录项**自身**的类型（lstat 语义），判断过程不跟随链接。
 */
function walk(dir: string, files: string[], depth = 0): void {
  if (depth > MAX_DEPTH) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files, depth + 1);
      continue;
    }
    // 只要普通文件：fifo / 设备节点读起来会阻塞，且对搜索没有意义。
    if (entry.isFile()) files.push(full);
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
    const head = Buffer.allocUnsafe(TEXT_SNIFF_BYTES);
    const read = readSync(fd, head, 0, TEXT_SNIFF_BYTES, 0);
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
  description: 'Search file contents in the workspace with a JavaScript regular expression — not shell grep or rg. Pass the pattern as a regex without surrounding slashes, and escape literal special characters. Results are capped: when you hit the cap, narrow with a path or a more specific pattern instead of paging through them.',
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
    // 多收一条：正好等于上限时无法区分「搜完了」和「被截断」，多看一眼才敢下结论。
    let capped = false;
    for (const file of files) {
      if (!looksTextual(file)) continue;
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const rel = toWorkspaceRelative(ctx.workspaceRoot, file);
      scanLines(text, (line, lineNo) => {
        if (!regex.test(line)) return true;
        if (hits.length >= HIT_LIMIT) {
          capped = true;
          return false;
        }
        hits.push(`${rel}:${lineNo}:${line}`);
        return true;
      });
      if (capped) break;
    }
    if (hits.length === 0) return { ok: true, content: 'no matches' };
    const body = hits.join('\n');
    if (!capped) return { ok: true, content: clip(body) };
    return {
      ok: true,
      content: clip(
        `${body}\n\n(reached the ${HIT_LIMIT}-match cap — more matches may exist; narrow with a path or a more specific pattern)`,
      ),
    };
  },
};
