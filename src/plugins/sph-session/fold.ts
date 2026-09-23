/**
 * 会话状态折叠：把 append-only 的记录流重放成当前状态。
 *
 * 动机：todo、当前模型、任务目标这些状态原本只活在进程内存里，`--resume` / `/resume`
 * 之后就凭空消失——恢复出来的上下文与用户离开时不是同一件事。这里不改存储格式，
 * 只是把「状态变更」也写成事件（`todo` / `model_selection` / `goal` /
 * `tool_result`），恢复时按序折叠。旧会话没有这些事件，折叠结果就是空状态，天然向后兼容。
 *
 * 折叠必须是纯函数且完全容错：会话文件是可追加日志，坏行、未来新增的事件类型、
 * 第三方写入的无关事件都可能出现，任何一种都不该让恢复失败。
 */

import type { TodoItem } from '../services.js';
import { isRecord } from '../../util.js';
import type { SessionFailure, SessionRecord } from '../../session/types.js';

export type { SessionFailure };

/** 保留最近几次工具失败：够模型知道「上次卡在哪」，又不会把上下文堆满。 */
export const MAX_TRACKED_FAILURES = 3;
/** 失败摘要长度上限，避免一条超长报错把事件撑成第二个工具结果。 */
const FAILURE_EXCERPT_LIMIT = 200;

export interface FoldedSessionState {
  todos: TodoItem[];
  /** 会话最后一次显式选择的模型；从未选过则 undefined。 */
  model?: string;
  contextWindow?: number;
  maxTokens?: number;
  /** 跨轮次的任务目标；空字符串表示已清除。 */
  goal?: string;
  /**
   * 会话出现过的最大代理深度（对齐 deepseek-harness 的持久化 delegationDepth：
   * 递归预算必须活过持久化——resume 拿它当下限，恢复出的子代理才不会伪装成顶层继续派生）。
   */
  depth: number;
  /** 最近的工具失败（最旧在前）。 */
  failures: SessionFailure[];
  /**
   * 上次 recap 覆盖到第几个主轮次（水印）。
   *
   * 自动 recap 靠它判断「距上次 recap 有没有新轮次」，所以必须活过持久化：
   * 只看内存的话，重启一次就会把同一段会话再 recap 一遍。
   * 手动与自动 recap 提交时都会推进它（对齐 grok-build 的 last_recap_main_turn）。
   */
  lastRecapMainTurn: number;
  /** 最近一次 recap 的正文（含未上屏的长尾输出），供 /status 展示。 */
  lastRecap?: string;
  /** 计划模式是否激活（last-wins）。 */
  planMode: boolean;
  /** 最近一次 turn 是否因崩溃/中断收尾（last-wins）。 */
  lastTurnInterrupted: boolean;
  /**
   * 本会话**整棵代理树**的累计 token 用量，供预算判断。
   *
   * 构成（两部分不相交，不会重复计）：
   * - 自己（含压缩摘要等辅助调用）的 `usage` 事件；
   * - 每个子代理 end 事件里的 `tokens` 汇总——子代理的用量记在它自己的会话文件里，
   *   父会话只留这一个数字，而它已经含了孙代理的量。
   * 放在折叠里而不是内存里，预算就自然活过 resume：重启后不会从零开始重新烧一遍。
   */
  tokensUsed: number;
}

function emptySessionState(): FoldedSessionState {
  return {
    todos: [],
    failures: [],
    depth: 0,
    lastRecapMainTurn: 0,
    planMode: false,
    lastTurnInterrupted: false,
    tokensUsed: 0,
  };
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
 * - `model_selection` / `goal` 都是 last-wins；
 * - `recap` 的 mainTurns 是水印（last-wins，只在提交时写入），正文保留最近一次；
 * - `tool_result` 只记失败，滑动保留最近 MAX_TRACKED_FAILURES 条。
 * - `plan_mode` 是 last-wins 布尔；缺省或坏数据视为未激活。
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
      case 'turn_start': {
        state.lastTurnInterrupted = false;
        const startDepth = data.depth;
        if (typeof startDepth === 'number' && Number.isFinite(startDepth) && startDepth > state.depth) {
          state.depth = Math.floor(startDepth);
        }
        break;
      }
      case 'turn_end': {
        // 深度取历史最大值：单调递增的持久化预算，resume 后不会因从零计数而越权派生。
        const eventDepth = data.depth;
        if (typeof eventDepth === 'number' && Number.isFinite(eventDepth) && eventDepth > state.depth) {
          state.depth = Math.floor(eventDepth);
        }
        state.lastTurnInterrupted = data.interrupted === true;
        break;
      }
      case 'recap': {
        const mainTurns = asFiniteNumber(data.mainTurns);
        // 只有「提交过」的 recap 才推进水印：失败/取消的 recap 不写事件，
        // 但坏数据可能带负数或小数，夹到非负整数。
        if (mainTurns !== undefined && mainTurns >= 0) state.lastRecapMainTurn = Math.floor(mainTurns);
        const summary = typeof data.summary === 'string' ? data.summary.trim() : '';
        if (summary !== '') state.lastRecap = summary;
        break;
      }
      case 'plan_mode': {
        if (typeof data.active === 'boolean') state.planMode = data.active;
        break;
      }
      case 'usage': {
        // 自己的 LLM 调用（含 compact_model / review_model 这类辅助调用）都记在这。
        const prompt = asFiniteNumber(data.promptTokens) ?? 0;
        const completion = asFiniteNumber(data.completionTokens) ?? 0;
        state.tokensUsed += Math.max(0, prompt) + Math.max(0, completion);
        break;
      }
      case 'subagent': {
        // 只认 end：start 里没有用量。tokens 是该子代理（含其后代）的总量。
        if (data.phase !== 'end') break;
        state.tokensUsed += Math.max(0, asFiniteNumber(data.tokens) ?? 0);
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
  // todo 事件的**写入**由插件提供（todoEventData），这里只保留读取。
  // 写入方变了而读取方不变，事件的 JSON 形状仍由 fold 的 case 'todo' 定义——
  // 插件负责产出这个形状，核心负责把它读回 TodoItem[]。
  modelSelection: (input: { model: string; contextWindow?: number; maxTokens?: number }): Record<string, unknown> => ({
    model: input.model,
    contextWindow: input.contextWindow,
    maxTokens: input.maxTokens,
  }),
  goal: (text: string): Record<string, unknown> => ({ text }),
  /**
   * recap 落盘：正文 + 触发方式 + 水印 + 是否上屏。
   * `shown: false` 是自动 recap 的长尾输出（落盘留档但没展示），回放时据此跳过。
   */
  recap: (input: { summary: string; auto: boolean; mainTurns: number; shown: boolean }): Record<string, unknown> => ({
    summary: input.summary,
    auto: input.auto,
    mainTurns: input.mainTurns,
    shown: input.shown,
  }),
  planMode: (active: boolean): Record<string, unknown> => ({ active }),
  toolFailure: (tool: string, content: string): Record<string, unknown> => ({
    tool,
    ok: false,
    excerpt: content.slice(0, FAILURE_EXCERPT_LIMIT),
  }),
};
