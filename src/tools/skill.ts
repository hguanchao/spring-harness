import { existsSync, readFileSync } from 'node:fs';
import { asString, clip, type ToolContext, type ToolResult, type ToolSpec } from './types.js';

export const skillTool: ToolSpec = {
  name: 'skill',
  description: 'Load a skill SKILL.md by catalog name. Use when a listed skill matches the task.',
  schema: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const name = asString(args, 'name');
    const entry = ctx.skills.find((skill) => skill.name === name);
    if (!entry) return { ok: false, content: `unknown skill: ${name}` };
    if (!existsSync(entry.path)) return { ok: false, content: `skill file missing: ${entry.path}` };
    return { ok: true, content: clip(readFileSync(entry.path, 'utf8'), 20_000) };
  },
};
