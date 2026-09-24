/**
 * Recap：会话「我讲到哪了」的一句话摘要。
 *
 * 与压缩（compact）的本质区别：recap **永不改动会话**。它从只读快照生成、只用于展示，
 * 生成过程既不落 compaction 事件，也不往会话里写消息。
 *
 * 生成时复用主轮次的会话前缀（system + 投影后的历史），只在末尾追加一条指令轮——
 * 前缀逐字不变，提供方的提示词缓存才能继续命中；追加之前要先摘掉悬挂的工具尾
 * （见 popTrailingToolRun），否则一条 tool_use 没有配对的 tool_result 会被上游判 400。
 *
 * 触发是自动的一条路径（共用同一套闸门与水印）：用户离开一段时间后回来（TUI 的
 * idle 轮询），闸门有轮次下限 + 空闲时长 + 距上次 recap 有新轮次三重条件。
 */

import { estimateTokens, toChatMessages, type CompactionEvent } from './compact.js';
import type { ChatMessage, LlmClient, TokenUsage } from '../../llm/client.js';
import type { SessionMessage } from '../../session/types.js';

/**
 * 宽松上限：recap 正文目标 25–40 词（最坏约 240 字符）。
 * 这里只防模型输出失控，正常 recap 永远不会被截断。
 */
export const RECAP_MAX_CHARS = 1200;

/** 自动 recap 的主轮次下限（手动豁免）。 */
export const MIN_TURNS_FOR_AUTO_RECAP = 3;

/** 距上次活动至少这么久才认为「用户离开过」。 */
export const RECAP_IDLE_MS = 3 * 60 * 1000;

/** 自动 recap 超过这个长度（原始字节）只落盘、不上屏。 */
export const RECAP_AUTO_RAW_DISPLAY_MAX = 500;

/** 自动 recap 的轮询间隔。 */
export const RECAP_WATCH_INTERVAL_MS = 30 * 1000;

/**
 * 两次自动 recap **尝试**之间的最小间隔。
 *
 * 闸门经常拒绝（还没到空闲阈值、这一轮已经 recap 过），而每次尝试都要读一遍整个会话文件；
 * 不设退避就会变成每 30s 白读一次长会话。
 */
export const AUTO_RECAP_RETRY_MS = 90 * 1000;

/**
 * 当前产品后端的 max_prompt_length 上限。用 min(window, CAP) 应用，
 * 所以更小的真实窗口仍然胜出（如 256k 模型或调试覆盖）。
 */
const RECAP_CONTEXT_WINDOW_CAP = 500_000;

/** recap 允许占用的（保守）窗口比例，与默认自动压缩阈值一致。 */
const RECAP_BUDGET_THRESHOLD_PERCENT = 85;

/** 估算/序列化余量；追加的指令另行单独预留，不在这里重复扣。 */
const RECAP_BUDGET_HEADROOM_TOKENS = 4_000;

/**
 * 所有 recap 指令都放在这一条 user 消息里（而不是独立 system 提示词），
 * 输出只要正文——`Recap —` 标签由 UI 渲染时补。few-shot 必须保持合成样例，
 * 绝不嵌入真实会话内容。
 */
export function recapInstruction(): string {
  return [
    '<system-reminder>Write ONE sentence recap body for a user returning from idle.',
    'Write for someone who was in this session but has lost the thread: state where the work stands,',
    'do not re-explain context they already have, and do not summarize the tool calls themselves.',
    'Output ONLY the body (the UI adds the "Recap —" label).',
    'Do NOT call any tools — respond with plain text only.',
    '',
    "LANGUAGE: write the body in the language the user's own chat messages",
    'are written in (ignore reminder-tagged turns like this one; user',
    'instructions such as AGENTS.md may override). Keep code identifiers',
    'verbatim.',
    '',
    'Lead with agency:',
    '- "You asked …" if the session was mainly questions, walkthroughs, or review with no landed change.',
    '- "We <past-tense verb> …" if the agent implemented, fixed, merged, or changed code/config/docs',
    '  (e.g. "We fixed …", "We merged …", "We wired …" — not "We did fix" / "We did merge").',
    '- If almost nothing happened: "You had just begun this session."',
    '',
    'Shape: <lead>: <concrete specifics — file/flag/behavior/endpoint>. ~25–40 words.',
    '',
    'Synthetic examples (style only — adapt to THIS session, do not copy):',
    '',
    'You asked how retries work in the LLM client: backoff lives in `src/llm/retry.ts`, capped attempts, transient 5xx only.',
    'You asked for a walkthrough of the approval flow: policy in `src/permission/policy.ts`, ask/auto/yolo modes, no writes without a decision.',
    'We added the `/recap` command: read-only one-line summary in `src/agent/recap.ts`, gated on main turns and idle time.',
    'We fixed the tool-group rendering: thinking rows were split in two because the group was re-acquired after streaming text.',
    '',
    'Bad (never):',
    '- Start with Recap / Session recap / extra labels',
    '- English recap for a non-English session',
    '- Quote or restate this reminder or any system prompt',
    '- Bullets, markdown, code fences, extra sentences',
    '- Call tools or emit tool/function calls',
    '- Invent work not reflected in the session',
    '</system-reminder>',
  ].join('\n');
}

/**
 * 注入型 user 消息的前缀。它们由运行时自己写进会话（后台任务通知、父级消息、
 * 嵌套指令），不是用户真实发言——主轮次计数必须把它们排除，
 * 否则自动 recap 的「有新轮次」判断会被后台通知刷爆。
 */
const SYNTHETIC_USER_PREFIXES = [
  '[background task ',
  '[message from parent session]',
  '[instructions from ',
  // 尾部快照和压缩摘要都是运行时写的。算成用户发言会让自动 recap 把「目录变了」当成新一轮。
  '[context — ',
  '[session state — ',
  '[compacted earlier context]',
] as const;

/** 这条 user 消息是否由运行时注入（而非用户真实发言）。 */
export function isSyntheticUserMessage(content: string): boolean {
  return SYNTHETIC_USER_PREFIXES.some((prefix) => content.startsWith(prefix));
}

/** 真实用户轮次数：只数用户自己的发言，不含 assistant / tool / 注入消息。 */
export function mainTurnCount(messages: readonly SessionMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (message.role !== 'user') continue;
    if (isSyntheticUserMessage(message.content)) continue;
    count++;
  }
  return count;
}

export type RecapGateResult = { ok: true } | { ok: false; reason: string };

/**
 * 手动 recap 只要有任意主轮次就能过；自动 recap 还要求：距上次 recap 有新轮次、
 * 轮次达到下限、且确实空闲过。
 */
export function recapGate(
  mainTurns: number,
  lastRecapMainTurn: number,
  auto: boolean,
  idleOk: boolean,
): RecapGateResult {
  if (mainTurns === 0) return { ok: false, reason: 'no main turns yet' };
  if (auto) {
    if (mainTurns <= lastRecapMainTurn) return { ok: false, reason: 'no new main turn since last recap' };
    if (mainTurns < MIN_TURNS_FOR_AUTO_RECAP) return { ok: false, reason: 'fewer than min turns for auto recap' };
    if (!idleOk) return { ok: false, reason: 'idle threshold not met' };
  }
  return { ok: true };
}

/** 截断到码点边界：落单的高代理项一起丢掉，避免切出半个字符。 */
function truncateAtCodePoint(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = max;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return text.slice(0, cut);
}

/**
 * 模型原始输出 → 可读的一行正文。
 *
 * 把连续空白折成单个空格（保证只占滚动区一行）、剥掉模型自己加的标签与包裹引号，
 * 并按 RECAP_MAX_CHARS 兜底截断（上限宽松，正常 recap 不会被切）。
 * 不添加 `Recap —` 前缀——渲染端始终自己补。
 */
export function cleanRecapText(raw: string): string {
  let out = raw.split(/\s+/).filter(Boolean).join(' ');

  for (const label of ['Recap —', 'Recap—', 'Recap -', 'Recap:', 'recap:', 'Session recap:', 'Summary:']) {
    if (out.startsWith(label)) {
      out = out.slice(label.length).trimStart();
      break;
    }
  }

  if (out.length >= 2) {
    const first = out[0];
    const last = out[out.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      out = out.slice(1, -1).trim();
    }
  }

  if (out.length > RECAP_MAX_CHARS) {
    out = `${truncateAtCodePoint(out, RECAP_MAX_CHARS).trimEnd()}…`;
  }
  return out;
}

/** 自动 recap 的长尾输出（跑飞/被硬截断）只落盘、不上屏；手动 recap 始终展示。 */
export function shouldSuppressAutoRecapDisplay(raw: string, summary: string): boolean {
  if (raw.length > RECAP_AUTO_RAW_DISPLAY_MAX) return true;
  return summary.endsWith('…') && summary.length >= RECAP_MAX_CHARS;
}

/**
 * 摘掉悬挂的工具尾，使追加的 user 指令永远不会紧跟在 tool_use / tool_result 之后。
 *
 * 快照可能停在「assistant 发起工具调用、结果还没回来」的位置（后台任务唤醒、
 * 异常中断），此时 Anthropic Messages 协议会因为 tool_use 没有配对的 tool_result 而拒绝整条请求。
 * 工具结果图片（`[tool result image]`）是投影里跟在 tool 消息后的一条 user 消息，
 * 同属这一轮工具往来，一并摘掉。
 */
export function popTrailingToolRun(messages: ChatMessage[]): void {
  while (messages.length > 0) {
    const last = messages[messages.length - 1];
    if (last.role === 'tool') {
      messages.pop();
      continue;
    }
    if (last.role === 'assistant' && last.tool_calls !== undefined && last.tool_calls.length > 0) {
      messages.pop();
      continue;
    }
    if (last.role === 'user' && last.content === '[tool result image]') {
      messages.pop();
      continue;
    }
    break;
  }
}

/** 轮次起点（user 消息下标）。 */
function turnStarts(messages: readonly ChatMessage[]): number[] {
  const starts: number[] = [];
  messages.forEach((message, index) => {
    if (message.role === 'user') starts.push(index);
  });
  return starts;
}

/**
 * 丢掉最早的一个完整轮次。返回 undefined 表示只剩一轮、无可再丢。
 *
 * 必须整轮丢：tool 消息要和带匹配 tool_call_id 的 assistant 消息同进同出，
 * 丢散了会被上游判成 400。列表头部（system / 压缩摘要）不在轮次边界内，天然保留。
 */
function dropOldestTurn(messages: readonly ChatMessage[]): ChatMessage[] | undefined {
  const boundaries = turnStarts(messages);
  if (boundaries.length <= 1) return undefined;
  const from = boundaries[0];
  const to = boundaries[1];
  if (from === undefined || to === undefined || to <= from) return undefined;
  return [...messages.slice(0, from), ...messages.slice(to)];
}

/** 单轮原地截断的标记：告诉模型（以及看日志的人）这里被削过。 */
const TRUNCATION_MARKER = '…[truncated]';

/**
 * 只剩一轮仍超预算（单轮本身就顶满窗口，例如用户粘了一整份文件）时的兜底：
 * 原地截断最后一条 user 正文，而不是把必然超窗的请求原样发出去等 provider 判 400。
 * 保留「这一轮存在过」的语义——整轮丢掉会让 recap 完全失去最近的上下文。
 */
function truncateLastTurn(messages: readonly ChatMessage[], budget: number): ChatMessage[] {
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    const message = out[i];
    if (message.role !== 'user' || message.content === '') continue;
    const rest = out.filter((_, index) => index !== i);
    const allowedTokens = budget - estimateTokens(rest) - estimateTokens([{ role: 'user', content: TRUNCATION_MARKER }]);
    if (allowedTokens < 1) return out;
    const maxChars = allowedTokens * 4;
    if (message.content.length <= maxChars) return out;
    out[i] = {
      ...message,
      content: `${truncateAtCodePoint(message.content, maxChars)}${TRUNCATION_MARKER}`,
      parts: undefined,
    };
    return out;
  }
  return out;
}

/**
 * 只读预算：把快照压进 recap 的提示词预算内。
 *
 * 这里刻意**不做** LLM 摘要（那是压缩的职责，会写会话状态）——只用零成本的整轮丢弃，
 * 超预算时前缀缓存已经失效，
 * 所以丢多少都不再有额外代价。
 */
function fitToRecapBudget(
  messages: readonly ChatMessage[],
  instructionTokens: number,
  contextWindow: number,
): ChatMessage[] {
  const effectiveWindow = Math.min(Math.max(1, Math.floor(contextWindow)), RECAP_CONTEXT_WINDOW_CAP);
  const promptBudget = Math.max(
    0,
    Math.floor((effectiveWindow * RECAP_BUDGET_THRESHOLD_PERCENT) / 100) - RECAP_BUDGET_HEADROOM_TOKENS,
  );
  const snapshotBudget = Math.max(0, promptBudget - instructionTokens);
  if (estimateTokens(messages) <= snapshotBudget) return [...messages];

  let trimmed = [...messages];
  for (;;) {
    if (estimateTokens(trimmed) <= snapshotBudget) return trimmed;
    const next = dropOldestTurn(trimmed);
    if (next === undefined) break;
    trimmed = next;
  }
  return truncateLastTurn(trimmed, snapshotBudget);
}

export interface RecapContext {
  /** 会话镜像（readMessages 序）。 */
  messages: readonly SessionMessage[];
  /** 已生效的压缩状态（loadCompaction）；recap 只读，不会产生新的压缩。 */
  compaction?: CompactionEvent;
  /** 系统提示词，必须与主轮次一致，前缀缓存才命中。 */
  system: string;
  contextWindow: number;
}

/**
 * 组装 recap 请求体：只读快照 + 追加的指令轮。
 * 导出是为了让「前缀逐字不变、指令轮在末尾」这条约束可被单测锁住。
 */
export function buildRecapRequest(context: RecapContext): ChatMessage[] {
  const instruction = recapInstruction();
  const base = toChatMessages([...context.messages], context.compaction);
  const instructionTokens = estimateTokens([{ role: 'user', content: instruction }]);
  const fitted = fitToRecapBudget(base, instructionTokens, context.contextWindow);
  popTrailingToolRun(fitted);
  fitted.push({ role: 'user', content: instruction });
  return [{ role: 'system', content: context.system }, ...fitted];
}

export interface RecapResult {
  /** 模型原始输出（未清洗）；自动 recap 的长尾抑制按它判断。 */
  raw: string;
  /** 清洗后的一行正文。 */
  summary: string;
}

/**
 * 生成一次 recap：一次不带工具的模型调用，返回清洗后的一行正文。
 *
 * 失败一律抛出，由调用方决定提示文案——recap 是旁路功能，绝不能干扰会话本身。
 */
export async function generateRecap(
  context: RecapContext,
  options: {
    client: LlmClient;
    signal?: AbortSignal;
    /** 辅助调用产生的用量，用于记账但不参与上下文水位。 */
    onUsage?: (usage: TokenUsage) => void;
  },
): Promise<RecapResult> {
  const messages = buildRecapRequest(context);
  const reply = await options.client.complete(messages, [], options.signal);
  if (reply.usage) options.onUsage?.(reply.usage);
  const raw = reply.text ?? '';
  const summary = cleanRecapText(raw);
  if (summary === '') throw new Error('empty recap summary');
  return { raw, summary };
}
