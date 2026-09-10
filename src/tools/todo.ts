import type { TodoItem } from '../runtime/todos.js';
import { clip, type ToolContext, type ToolResult, type ToolSpec } from './types.js';

export const todoTool: ToolSpec = {
  name: 'todo',
  description: 'Replace the in-session todo list. statuses: pending | in_progress | completed.',
  schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            content: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['id', 'content', 'status'],
        },
      },
    },
    required: ['items'],
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const raw = args.items;
    if (!Array.isArray(raw)) return { ok: false, content: 'items must be an array' };
    const items: TodoItem[] = raw.map((row, i) => {
      if (!row || typeof row !== 'object') throw new Error(`items[${i}] invalid`);
      const rec = row as Record<string, unknown>;
      const status = rec.status;
      if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
        throw new Error(`items[${i}].status invalid`);
      }
      return {
        id: String(rec.id ?? i),
        content: String(rec.content ?? ''),
        status,
      };
    });
    return { ok: true, content: clip(JSON.stringify(ctx.todos.replace(items), null, 2)) };
  },
};
