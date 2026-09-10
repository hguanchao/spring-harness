import { existsSync, readdirSync, statSync } from 'node:fs';
import { assertInsideWorkspace, toWorkspaceRelative } from '../workspace/boundary.js';
import { asString, clip, type ToolContext, type ToolResult, type ToolSpec } from './types.js';

export const listDirTool: ToolSpec = {
  name: 'list_dir',
  description: 'List a directory inside the workspace.',
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
    const entries = readdirSync(abs, { withFileTypes: true })
      .filter((entry) => entry.name !== 'node_modules' && entry.name !== '.git')
      .slice(0, 200)
      .map((entry) => {
        const kind = entry.isDirectory() ? 'dir' : 'file';
        return `${kind.padEnd(4)} ${entry.name}`;
      });
    const header = toWorkspaceRelative(ctx.workspaceRoot, abs);
    return { ok: true, content: clip(`${header}\n${entries.join('\n') || '(empty)'}`) };
  },
};
