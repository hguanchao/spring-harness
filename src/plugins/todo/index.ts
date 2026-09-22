/**
 * todo 插件：模型维护的会话内进度清单。
 *
 * 从核心搬出来的第二个内置插件。搬移的动机与 sph-mcp 相同——这个能力是可选的、纯状态、
 * 无安全含义：插件缺席只是少一个工具，不影响任何工具能否运行，也不改变任何安全边界。
 *
 * ## 职责划分
 *
 * - 插件持有：`TodoList`（内存状态）、`todo` 工具（模型改清单的唯一入口）、`todo`
 *   会话事件的**序列化**（`todoEventData`，供核心写日志）。
 * - 核心保留：`TodoItem` / `TodoList` **类型**（`src/plugins/services.ts`）——折叠逻辑
 *   （`session/fold.ts`）要从日志里把 `todo` 事件读回 `TodoItem[]`，TUI 与 runTurn 也要
 *   把 `TodoList` 实例传来传去，这些都需要类型，但都不需要本插件的实现。
 * - 会话事件**写入**走核心：`runTurn` 检测到清单变化后 `appendEvent('todo', …)`。
 *   事件格式是核心与插件共同遵守的契约，所以序列化函数由插件提供、核心只消费数据。
 *
 * 分界线的检验：`[plugins] disabled = ["todo"]` 时，核心不引用本插件的任何代码，折叠、
 * TUI、runTurn 依旧能编译；只是日志里不再出现 `todo` 事件，工具表里没有 `todo` 工具。
 */

import type { PluginApi } from '../types.js';
import { TODO_SERVICE, type TodoItem, type TodoService } from '../services.js';
import type { ToolSpec } from '../../tools/types.js';
import { clip } from '../../tools/types.js';

/** 会话内进度清单。搬移前在 `src/runtime/todos.ts`，随插件迁入。 */
export class TodoList implements TodoService {
  private items: TodoItem[] = [];

  replace(items: TodoItem[]): TodoItem[] {
    this.items = items.map((item) => ({ ...item }));
    return this.list();
  }

  list(): TodoItem[] {
    return this.items.map((item) => ({ ...item }));
  }
}

const todoTool: ToolSpec = {
  name: 'todo',
  description:
    'Replace the in-session todo list — send the whole list every call, because it replaces rather than merges. statuses: pending | in_progress | completed. Keep at most one item in_progress at a time and mark items completed as they finish rather than batching them. Skip it for work that does not span multiple steps.',
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
  async execute(args, ctx) {
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

/** 插件入口。宿主按 `src/plugins/todo/` 装载，插件名取目录名。 */
export default function setup(api: PluginApi): void {
  const list = new TodoList();
  api.registerTool(todoTool);
  api.provide(TODO_SERVICE, list);
}
