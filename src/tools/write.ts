import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { assertInsideWorkspace, toWorkspaceRelative } from '../workspace/boundary.js';
import { asString, asStringOrEmpty, guardReadOnlyWrite, type ToolContext, type ToolResult, type ToolSpec } from './types.js';

export const writeTool: ToolSpec = {
  name: 'write',
  description: 'Create a new file or overwrite an entire file inside the workspace. Prefer search_replace for edits.',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const rel = asString(args, 'path');
    const denial = await guardReadOnlyWrite(ctx, rel, 'write');
    if (denial) return denial;
    const content = asStringOrEmpty(args, 'content');
    const abs = assertInsideWorkspace(ctx.workspaceRoot, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
    return { ok: true, content: `wrote ${toWorkspaceRelative(ctx.workspaceRoot, abs)} (${content.length} bytes)` };
  },
};
