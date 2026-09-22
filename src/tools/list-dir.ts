import { existsSync, readdirSync, statSync } from 'node:fs';
import { assertInsideWorkspace, toWorkspaceRelative } from '../workspace/boundary.js';
import { asString, clip, type ToolContext, type ToolResult, type ToolSpec } from './types.js';

/** 单次列出的条目上限；超出部分在结果里明说数量，避免模型把「没列出来」当成「不存在」。 */
const MAX_ENTRIES = 200;

export const listDirTool: ToolSpec = {
  name: 'ls',
  description: 'Use ls — this tool, not the shell command — to list a directory inside the workspace. node_modules and .git are skipped, and a directory over the entry cap is truncated with an explicit count, so an entry missing here is not proof it does not exist; use glob to search by name when you are unsure where a file lives.',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory relative to the workspace root' },
    },
    required: ['path'],
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const rel = asString(args, 'path');
    const abs = assertInsideWorkspace(ctx.workspaceRoot, rel);
    if (!existsSync(abs)) return { ok: false, content: `directory not found: ${rel}` };
    if (!statSync(abs).isDirectory()) return { ok: false, content: `not a directory: ${rel}` };
    const all = readdirSync(abs, { withFileTypes: true })
      .filter((entry) => entry.name !== 'node_modules' && entry.name !== '.git');
    const shown = all.slice(0, MAX_ENTRIES);
    const entries = shown.map((entry) => {
      const kind = entry.isDirectory() ? 'dir' : 'file';
      return `${kind.padEnd(4)} ${entry.name}`;
    });
    const header = toWorkspaceRelative(ctx.workspaceRoot, abs);
    const body = `${header}\n${entries.join('\n') || '(empty)'}`;
    const omitted = all.length - shown.length;
    return {
      ok: true,
      content: clip(omitted > 0 ? `${body}\n\n(${shown.length} of ${all.length} entries shown; narrow with glob)` : body),
    };
  },
};
