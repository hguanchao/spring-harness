/**
 * 会话状态折叠：把 append-only 的记录流重放成当前状态。
 *
 * 动机：todo、plan 模式、当前模型、任务目标这些状态原本只活在进程内存里，resume / `/switch`
 * 之后就凭空消失——恢复出来的上下文与用户离开时不是同一件事。这里不改存储格式，
 * 只是把「状态变更」也写成事件（`todo` / `plan_mode` / `model_selection` / `goal` /
 * `tool_result`），恢复时按序折叠。旧会话没有这些事件，折叠结果就是空状态，天然向后兼容。
 *
 * 折叠必须是纯函数且完全容错：会话文件是可追加日志，坏行、未来新增的事件类型、
 * 第三方写入的无关事件都可能出现，任何一种都不该让恢复失败。
 */

import type { TodoItem } from '../runtime/todos.js';
import type { SessionRecord } from './types.js';

/** 保留最近几次工具失败：够模型知道「上次卡在哪」，又不会把上下文堆满。 */
export const MAX_TRACKED_FAILURES = 3;
/** 失败摘要长度上限，避免一条超长报错把事件撑成第二个工具结果。 */
const FAILURE_EXCERPT_LIMIT = 200;

export interface SessionFailure {
  tool: string;
  excerpt: string;
  ts: string;
}

export interface FoldedSessionState {
  todos: TodoItem[];
  planMode: boolean;
  /** 会话最后一次显式选择的模型；从未选过则 undefined。 */
  model?: string;
  contextWindow?: number;
  maxTokens?: number;
  /** 跨轮次的任务目标；空字符串表示已清除。 */
  goal?: string;
  /** 最近的工具失败（最旧在前）。 */
  failures: SessionFailure[];
}

export function emptySessionState(): FoldedSessionState {
  return { todos: [], planMode: false, failures: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseTodoItems(value: unknown): TodoItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: TodoItem[] = [];
  for (const row of value) {
    if (!isRecord(row)) return undefined;
    const status = row.status;
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') return undefined;
    if (typeof row.id !== 'string' || typeof row.content !== 'string') return undefined;
    items.push({ id: row.id, content: row.content, status });
  }
  return items;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * 按序折叠全部事件。
 *
 * 语义：
 * - `todo` 是整表快照（last-wins），与工具本身的「整体替换」语义一致；
 * - `plan_mode` / `model_selection` / `goal` 都是 last-wins；
 * - `tool_result` 只记失败，滑动保留最近 MAX_TRACKED_FAILURES 条。
 */
export function foldSessionState(records: readonly SessionRecord[]): FoldedSessionState {
  const state = emptySessionState();
  for (const record of records) {
    if (record.type !== 'event') continue;
    const data = isRecord(record.data) ? record.data : {};
    switch (record.kind) {
      case 'todo': {
        const items = parseTodoItems(data.items);
        if (items) state.todos = items;
        break;
      }
      case 'plan_mode':
        if (typeof data.active === 'boolean') state.planMode = data.active;
        break;
      case 'model_selection': {
        if (typeof data.model !== 'string' || data.model.trim() === '') break;
        state.model = data.model.trim();
        const contextWindow = asFiniteNumber(data.contextWindow);
        const maxTokens = asFiniteNumber(data.maxTokens);
        if (contextWindow !== undefined) state.contextWindow = contextWindow;
        else delete state.contextWindow;
        if (maxTokens !== undefined) state.maxTokens = maxTokens;
        else delete state.maxTokens;
        break;
      }
      case 'goal': {
        const text = typeof data.text === 'string' ? data.text.trim() : '';
        if (text === '') delete state.goal;
        else state.goal = text;
        break;
      }
      case 'tool_result': {
        // 只保留失败：成功记录对恢复没有价值，却会让日志和内存都翻倍。
        if (data.ok !== false) break;
        const tool = typeof data.tool === 'string' ? data.tool : 'unknown';
        const excerpt = typeof data.excerpt === 'string' ? data.excerpt.slice(0, FAILURE_EXCERPT_LIMIT) : '';
        state.failures.push({ tool, excerpt, ts: record.ts });
        if (state.failures.length > MAX_TRACKED_FAILURES) state.failures.shift();
        break;
      }
      default:
        break;
    }
  }
  return state;
}

/** 折叠结果 → 事件数据。写事件与读事件共用同一套形状，避免两边漂移。 */
export const sessionEventData = {
  todo: (items: readonly TodoItem[]): Record<string, unknown> => ({ items: items.map((item) => ({ ...item })) }),
  planMode: (active: boolean): Record<string, unknown> => ({ active }),
  modelSelection: (input: { model: string; contextWindow?: number; maxTokens?: number }): Record<string, unknown> => ({
    model: input.model,
    contextWindow: input.contextWindow,
    maxTokens: input.maxTokens,
  }),
  goal: (text: string): Record<string, unknown> => ({ text }),
  toolFailure: (tool: string, content: string): Record<string, unknown> => ({
    tool,
    ok: false,
    excerpt: content.slice(0, FAILURE_EXCERPT_LIMIT),
  }),
};
