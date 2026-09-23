/**
 * 按路径模式发现文件：不含斜杠的模式匹配任意深度的基名，
 * 所以 "*.ts" 能找到整棵树里的 TypeScript 文件，不必再写递归前缀。
 * 只返回文件、不含目录；VCS 元数据目录不进。vendor 目录（node_modules / dist）
 * 也跳过——个人 harness 里扫进去几乎总是噪音。
 */
import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { assertInsideWorkspace, toWorkspaceRelative } from '../../workspace/boundary.js';
import { asString, clip, type ToolContext, type ToolResult, type ToolSpec } from '../../tools/types.js';

export const GLOB_MAX_RESULTS = 100;
const MAX_DEPTH = 24;
const SKIP = new Set(['node_modules', '.git', 'dist', '.sph', '.svn', '.hg', '.bzr', '.jj', '.sl']);

export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/');
  const full = normalized.includes('/') ? normalized : `**/${normalized}`;
  let i = 0;
  let out = '^';
  while (i < full.length) {
    if (full[i] === '*' && full[i + 1] === '*') {
      if (full[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 3;
      } else {
        out += '.*';
        i += 2;
      }
      continue;
    }
    if (full[i] === '*') {
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (full[i] === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    if ('\\^$+{}()|[]'.includes(full[i])) out += '\\';
    out += full[i];
    i += 1;
  }
  out += '$';
  return new RegExp(out, process.platform === 'win32' ? 'i' : '');
}

export function matchGlob(relPosix: string, pattern: string): boolean {
  return globToRegExp(pattern).test(relPosix.replace(/\\/g, '/'));
}

interface Hit {
  rel: string;
  mtimeMs: number;
}

function walk(dir: string, root: string, hits: Hit[], pattern: string, depth: number): void {
  if (depth > MAX_DEPTH) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, root, hits, pattern, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = toWorkspaceRelative(root, full);
    if (!matchGlob(rel, pattern)) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(full).mtimeMs;
    } catch {
      continue;
    }
    hits.push({ rel, mtimeMs });
  }
}

export const globTool: ToolSpec = {
  name: 'glob',
  description:
    'Use glob — not shell find — to discover files by path pattern. A pattern with no "/" matches basenames at any depth, so "*.ts" finds every matching file in the tree rather than only the top level. Results are files only, never directories. Hidden and git-ignored vendor dirs are omitted, so a file missing here is not proof it does not exist.',
  schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, e.g. "*.ts" or "src/**/*.java"' },
      path: { type: 'string', description: 'Optional subdirectory to search, relative to workspace' },
    },
    required: ['pattern'],
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const pattern = asString(args, 'pattern').trim();
    if (pattern === '') return { ok: false, content: 'pattern must be a non-empty string' };
    const startRel = typeof args.path === 'string' && args.path.trim() !== '' ? args.path.trim() : '.';
    const start = assertInsideWorkspace(ctx.workspaceRoot, startRel);
    if (!existsSync(start)) return { ok: false, content: `path not found: ${startRel}` };
    const hits: Hit[] = [];
    const stat = statSync(start);
    if (stat.isFile()) {
      const rel = toWorkspaceRelative(ctx.workspaceRoot, start);
      if (matchGlob(rel, pattern)) hits.push({ rel, mtimeMs: stat.mtimeMs });
    } else {
      walk(start, ctx.workspaceRoot, hits, pattern, 0);
    }
    if (hits.length === 0) return { ok: true, content: 'No files found' };
    hits.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.rel < b.rel ? -1 : 1));
    const shown = hits.slice(0, GLOB_MAX_RESULTS).map((hit) => hit.rel);
    const body = shown.join('\n');
    if (hits.length <= GLOB_MAX_RESULTS) return { ok: true, content: clip(body) };
    return {
      ok: true,
      content: clip(
        `${body}\n\n(Showing ${shown.length} of ${hits.length} paths, newest first. Narrow pattern or path to see more.)`,
      ),
    };
  },
};
