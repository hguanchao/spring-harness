import {
  CACHED_TOKEN_KEYS,
  COMPLETION_TOKEN_KEYS,
  firstFiniteNumber,
  firstString,
  PROMPT_TOKEN_KEYS,
  TEXT_KEYS,
  THINKING_KEYS,
  TOTAL_TOKEN_KEYS,
} from './aliases.js';
import { DEFAULT_REQUEST_CAPS, degradeRequestCaps, type ReasoningWire, type RequestCaps } from './compat.js';
import { streamFrameError } from './errors.js';
import { clampPromptCacheKey, openaiSessionHeaders, PROMPT_CACHE_RETENTION } from './prompt-cache.js';
import type { ProtocolAdapter } from './stream-client.js';
import type {
  ChatMessage,
  ReasoningEffort,
  ReasoningItem,
  StreamDelta,
  TokenUsage,
} from '../../llm/client.js';

export type {
  ChatMessage,
  ContentPart,
  LlmClient,
  LlmRetryInfo,
  ReasoningEffort,
  ReasoningItem,
  StreamDelta,
  TokenUsage,
} from '../../llm/client.js';
export { REASONING_EFFORTS } from '../../llm/client.js';

/**
 * 各端点把「命中缓存的输入 token」放在不同字段：
 * OpenAI 在 prompt_tokens_details.cached_tokens，DeepSeek 直接给 prompt_cache_hit_tokens，
 * 部分中转站给 cached_tokens。都不认识时返回 undefined（而不是 0）——「没上报」和
 * 「命中 0」在界面上应当区分开。
 */
function readCachedTokens(usage: Record<string, unknown>): number | undefined {
  const details = usage.prompt_tokens_details;
  if (details && typeof details === 'object') {
    const value = (details as Record<string, unknown>).cached_tokens;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return firstFiniteNumber(usage, CACHED_TOKEN_KEYS);
}

interface ToolAcc {
  id: string;
  name: string;
  arguments: string;
  /** Responses `output_item.id`，arguments.delta 用它寻址，不能只认 last-added。 */
  itemId?: string;
}

export interface SseAcc {
  text: string;
  thinking: string;
  tools: Map<number, ToolAcc>;
  reasoningItems: Map<string, ReasoningItem>;
  finish?: string;
  usage?: TokenUsage;
  /** Responses 协议的 arguments delta 事件不带 index，用它定位最近一个工具调用。 */
  currentToolIndex?: number;
  /** Anthropic thinking 块签名（signature_delta 累积）。 */
  signature?: string;
}

/** 三协议共用的空累积器；字段语义见 SseAcc。 */
export function newSseAcc(): SseAcc {
  return { text: '', thinking: '', tools: new Map(), reasoningItems: new Map() };
}

/** OpenAI / Responses 共用的 JSON + Bearer 头。 */
export function bearerJsonHeaders(apiKey: string): Record<string, string> {
  return {
    accept: 'text/event-stream',
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
  };
}

/**
 * chat.completions 上推理档位的几种写法。一次只发一种，避免不认识的字段把请求打成 400。
 * 一次只发一种：`reasoning_effort`、`reasoning.effort`、`thinking.type`、`enable_thinking`。
 * 端点报文点名哪一个，下一次就改用哪一个。
 */
export function chatReasoningFields(
  effort: Exclude<ReasoningEffort, 'off'> | undefined,
  wire: ReasoningWire,
): Record<string, unknown> {
  if (effort === undefined || wire === 'off') return {};
  if (wire === 'effort') return { reasoning_effort: effort };
  if (wire === 'object') return { reasoning: { effort } };
  if (wire === 'thinking') return { thinking: { type: 'enabled' } };
  return { enable_thinking: true };
}

/** off / 未设置都不发送推理档位；其余原值透传。 */
export function activeReasoningEffort(
  effort?: ReasoningEffort,
): Exclude<ReasoningEffort, 'off'> | undefined {
  return effort && effort !== 'off' ? effort : undefined;
}

/** SSE data 行 → 对象；`[DONE]`、坏 JSON、非对象一律视为空事件，不中断整段流。 */
export function parseSseJson(payload: string): Record<string, unknown> | undefined {
  if (payload === '[DONE]') return undefined;
  try {
    const json: unknown = JSON.parse(payload);
    if (json === null || typeof json !== 'object') return undefined;
    return json as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** 没有任何正文、思考、工具或推理项：对齐 EMPTY_RESPONSE，应重试而不是当成功空回复。 */
export function isEmptyReply(reply: StreamDelta): boolean {
  return !reply.text && !reply.thinking && !reply.toolCalls?.length && !reply.reasoning?.length;
}

/**
 * 工具参数是半截 JSON。断流时如果把它当成一次调用交回去，循环会解析失败，
 * 记成一次工具错误，模型再换一条命令重试——参数其实只是没传完。
 * 空字符串不算半截：有的调用本来就没有参数。
 */
export function toolArgumentsIncomplete(reply: StreamDelta): boolean {
  return (reply.toolCalls ?? []).some((call) => {
    const raw = call.arguments.trim();
    if (!raw) return false;
    try {
      JSON.parse(raw);
      return false;
    } catch {
      return true;
    }
  });
}

/** 把一段正文/思考增量写入累积器，并原样作为 delta 返回。 */
export function appendStreamDelta(
  acc: SseAcc,
  text?: string,
  thinking?: string,
): { textDelta?: string; thinkingDelta?: string } {
  const out: { textDelta?: string; thinkingDelta?: string } = {};
  if (thinking) {
    acc.thinking += thinking;
    out.thinkingDelta = thinking;
  }
  if (text) {
    acc.text += text;
    out.textDelta = text;
  }
  return out;
}

/** 三协议把用量归一化后都写进同一组字段。 */
export function writeUsage(
  acc: SseAcc,
  prompt: number,
  completion: number,
  total?: number,
  cached?: number,
): void {
  acc.usage = {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total ?? prompt + completion,
    ...(cached === undefined ? {} : { cachedTokens: cached }),
  };
}

/** 从 SSE / JSON 体里抽出 error.message；兼容 string 与 `{ message }`。 */
export function llmErrorMessage(error: unknown): string {
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
    try {
      return JSON.stringify(error);
    } catch {
      return 'unknown error';
    }
  }
  return 'unknown error';
}

type ChatDelta = {
  content?: string | null;
  text?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  thinking?: string | null;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
};

/** 下一个空闲工具槽位：index 缺席的网关新增调用时取最大键 +1，避免踩掉已有条目。 */
function nextToolSlot(acc: SseAcc): number {
  let max = -1;
  for (const slot of acc.tools.keys()) if (slot > max) max = slot;
  return max + 1;
}

/** 有的端点把思考放在 `reasoning_details[]` 的 text/summary 上，而不是一个字符串。 */
function thinkingText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue;
    const text = firstString(item as Record<string, unknown>, ['text', 'summary', 'content']);
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join('') : undefined;
}

function applyChatDelta(acc: SseAcc, delta: ChatDelta): { textDelta?: string; thinkingDelta?: string } {
  let textDelta: string | undefined;
  let thinkingDelta: string | undefined;
  const row = delta as unknown as Record<string, unknown>;
  const thinking = firstString(row, THINKING_KEYS) ?? thinkingText(row.reasoning_details);
  if (thinking) thinkingDelta = appendStreamDelta(acc, undefined, thinking).thinkingDelta;
  const text = firstString(row, TEXT_KEYS);
  if (text) textDelta = appendStreamDelta(acc, text).textDelta;
  for (const call of delta.tool_calls ?? []) {
    // 寻址顺序：规范形态按 index；不发 index 的网关按 id 匹配已开的调用；
    // 都没有就挂到「当前正在填充」的那条上——两个调用完全无差别时任何实现都无法拆分。
    if (typeof call.index === 'number' && Number.isFinite(call.index)) {
      acc.currentToolIndex = call.index;
    } else if (call.id) {
      let found: number | undefined;
      for (const [slot, tool] of acc.tools) {
        if (tool.id === call.id) {
          found = slot;
          break;
        }
      }
      acc.currentToolIndex = found ?? nextToolSlot(acc);
    } else if (acc.currentToolIndex === undefined) {
      acc.currentToolIndex = nextToolSlot(acc);
    }
    const index = acc.currentToolIndex;
    const current = acc.tools.get(index) ?? { id: '', name: '', arguments: '' };
    if (call.id) current.id = call.id;
    if (call.function?.name) current.name += call.function.name;
    if (call.function?.arguments) current.arguments += call.function.arguments;
    acc.tools.set(index, current);
  }
  return { textDelta, thinkingDelta };
}

/** 解析 OpenAI chat.completions SSE 的一行 data payload。 */
export function applySsePayload(payload: string, acc: SseAcc): { textDelta?: string; thinkingDelta?: string } {
  if (payload === '[DONE]') return {};
  const json = parseSseJson(payload);
  if (!json) return {};
  // 兼容端点把业务错误塞进 SSE data（HTTP 仍 200）：必须抛出，否则空 choices 会被当成成功空回复。
  // 是否可重试由 streamFrameError 统一判定：网关断流措辞按传输抖动重打，审核/鉴权等终态上抛。
  const errorField = json.error;
  if (errorField !== undefined && errorField !== null) {
    throw streamFrameError('LLM error', llmErrorMessage(errorField));
  }
  const usageRaw =
    json.usage && typeof json.usage === 'object'
      ? json.usage
      : // 有的端点把 usage 放在 choice.usage 而不是 chunk.usage。
        (json as { choices?: Array<{ usage?: unknown }> }).choices?.[0]?.usage;
  if (usageRaw && typeof usageRaw === 'object') {
    const usage = usageRaw as Record<string, unknown>;
    const prompt = firstFiniteNumber(usage, PROMPT_TOKEN_KEYS);
    const completion = firstFiniteNumber(usage, COMPLETION_TOKEN_KEYS);
    const total = firstFiniteNumber(usage, TOTAL_TOKEN_KEYS);
    // 部分网关在工具调用首包塞 usage: {prompt_tokens:0}，不能把后面的真值盖掉，
    // 也不能让界面显示 0 / 1.0M。
    if ((prompt !== undefined && prompt > 0) || (completion !== undefined && completion > 0)) {
      writeUsage(acc, prompt ?? 0, completion ?? 0, total, readCachedTokens(usage));
    }
  }
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return {};
  const choice = choices[0] as {
    finish_reason?: string | null;
    delta?: ChatDelta;
    /** 非流式完整报文：网关把 stream 折成一条 JSON 时走这里。 */
    message?: ChatDelta;
  };
  if (choice.finish_reason) acc.finish = choice.finish_reason;
  const delta = choice.delta ?? choice.message;
  if (!delta) return {};
  return applyChatDelta(acc, delta);
}

export function finishStream(acc: SseAcc): StreamDelta {
  const toolCalls = [...acc.tools.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, call], i) => ({
      id: call.id || `call_${i}`,
      name: call.name,
      arguments: call.arguments,
    }));
  const reasoning = [...acc.reasoningItems.values()].filter((item) => item.encryptedContent);
  return {
    text: acc.text,
    thinking: acc.thinking || undefined,
    ...(acc.signature ? { thinkingSignature: acc.signature } : {}),
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    reasoning: reasoning.length > 0 ? reasoning : undefined,
    finishReason: acc.finish,
    usage: acc.usage,
  };
}

/** user 消息含图片 parts 时按多模态数组序列化，其余角色保持纯字符串。 */
function serializeMessage(message: ChatMessage): Record<string, unknown> {
  const base: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.parts && message.parts.length > 0 && message.role === 'user') {
    base.content = [{ type: 'text', text: message.content }, ...message.parts];
  }
  if (message.tool_call_id !== undefined) base.tool_call_id = message.tool_call_id;
  if (message.name !== undefined) base.name = message.name;
  if (message.tool_calls !== undefined) {
    base.tool_calls = message.tool_calls.map((call) => ({
      id: call.id,
      type: call.type,
      function: call.function,
    }));
  }
  return base;
}

export interface RequestBodyOptions {
  model: string;
  messages: ChatMessage[];
  tools: unknown[];
  reasoningEffort?: ReasoningEffort;
  maxTokens?: number;
  /** 会话身份：作为 `prompt_cache_key`，让同一会话的请求落到同一台机器上。 */
  sessionId?: string;
}

export interface FlatToolSpec {
  name: string;
  description: string;
  parameters: unknown;
}

/** 内部工具面是 chat.completions 嵌套形态；Responses/Anthropic 需要扁平结构，这里统一摊平。 */
export function flattenToolSpec(tool: unknown): FlatToolSpec {
  const spec = tool as { function?: { name?: string; description?: string; parameters?: unknown }; name?: string; description?: string; parameters?: unknown };
  const fn = spec.function ?? spec;
  return {
    name: fn.name ?? '',
    description: fn.description ?? '',
    parameters: fn.parameters ?? { type: 'object' },
  };
}

/** 组装 chat.completions 请求体；JSON.stringify 会丢弃 undefined 字段，off/未设置即不发送该参数。 */
export function buildRequestBody(
  options: RequestBodyOptions,
  caps: RequestCaps = DEFAULT_REQUEST_CAPS,
): Record<string, unknown> {
  // 上限字段和推理开关都由 caps 决定。端点点名另一个名字时，degrade 改 caps 再发。
  const effort = activeReasoningEffort(options.reasoningEffort);
  return {
    model: options.model,
    messages: options.messages.map(serializeMessage),
    tools: options.tools.length > 0 ? options.tools : undefined,
    tool_choice: options.tools.length > 0 ? 'auto' : undefined,
    stream: true,
    // include_usage 是 OpenAI 私有扩展：部分兼容端点遇到未知字段直接 400，故可降级关闭。
    stream_options: caps.streamOptions ? { include_usage: true } : undefined,
    ...chatReasoningFields(effort, caps.reasoningWire),
    [caps.outputLimit]: options.maxTokens,
    // 前缀缓存是自动的，这两个字段负责「落到同一台机器」与「保留更久」。
    prompt_cache_key: caps.promptCacheKey ? clampPromptCacheKey(options.sessionId) : undefined,
    prompt_cache_retention: caps.promptCacheRetention ? PROMPT_CACHE_RETENTION : undefined,
  };
}

export const openaiAdapter: ProtocolAdapter = {
  path: '/chat/completions',
  headers: bearerJsonHeaders,
  buildBody: (input, caps) => JSON.stringify(buildRequestBody(input, caps)),
  apply: applySsePayload,
  degrade: degradeRequestCaps,
  // 会话亲和的追加头：让同一会话的请求尽量落到同一台机器，各自的前缀缓存才叠得起来。
  sessionHeaders: openaiSessionHeaders,
};
