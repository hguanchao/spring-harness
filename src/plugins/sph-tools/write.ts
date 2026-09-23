import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { assertInsideWorkspace, toWorkspaceRelative } from '../../workspace/boundary.js';
import { asString, asStringOrEmpty, guardReadOnlyWrite, type ToolContext, type ToolResult, type ToolSpec } from '../../tools/types.js';

export const writeTool: ToolSpec = {
  name: 'write',
  description: 'Create a new file or replace an entire file inside the workspace. It overwrites, so read the file first unless you created it in this session; prefer edit for a targeted change, and reserve this for new files and full rewrites.',
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
    const unseen = ctx.observation?.denyIfUnseen(abs);
    if (unseen) return unseen;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
    ctx.observation?.noteWritten(abs);
    return { ok: true, content: `wrote ${toWorkspaceRelative(ctx.workspaceRoot, abs)} (${Buffer.byteLength(content, 'utf8')} bytes)` };
  },
};
