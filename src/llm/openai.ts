import type { ProtocolAdapter } from './stream-client.js';

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /**
   * 命中提示缓存的输入 token 数（可选：不是所有端点都上报）。
   * 约定 promptTokens 是**含缓存**的总输入量，各协议在这一层归一化，
   * 这样「命中率 = cachedTokens / promptTokens」在三家协议下含义一致。
   */
  cachedTokens?: number;
}

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
  for (const key of ['prompt_cache_hit_tokens', 'cached_tokens']) {
    const value = usage[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** 仅 user 消息使用：与 content 一起序列化为 OpenAI 多模态 parts。 */
  parts?: ContentPart[];
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

export interface StreamDelta {
  text?: string;
  /** 推理模型（DeepSeek reasoner 等）暴露的思考链；delta.reasoning_content 累积。 */
  thinking?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  finishReason?: string;
  usage?: TokenUsage;
}

export interface LlmClient {
  complete(
    messages: ChatMessage[],
    tools: unknown[],
    signal?: AbortSignal,
    onDelta?: (delta: { text: string }) => void,
  ): Promise<StreamDelta>;
}

/** 推理力度档位：off 表示 sph 不干预（不发送 reasoning_effort，走端点默认）；其余档位按协议原值透传。 */
export const REASONING_EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

interface ToolAcc {
  id: string;
  name: string;
  arguments: string;
}

export interface SseAcc {
  text: string;
  thinking: string;
  tools: Map<number, ToolAcc>;
  finish?: string;
  usage?: TokenUsage;
  /** Responses 协议的 arguments delta 事件不带 index，用它定位最近一个工具调用。 */
  currentToolIndex?: number;
}

/** 三协议共用的空累积器；字段语义见 SseAcc。 */
export function newSseAcc(): SseAcc {
  return { text: '', thinking: '', tools: new Map() };
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

/** 解析 OpenAI chat.completions SSE 的一行 data payload。 */
export function applySsePayload(payload: string, acc: SseAcc): { textDelta?: string } {
  if (payload === '[DONE]') return {};
  const json: unknown = JSON.parse(payload);
  if (json === null || typeof json !== 'object') return {};
  // 兼容端点把业务错误塞进 SSE data（HTTP 仍 200）：必须抛出，否则空 choices 会被当成成功空回复。
  const errorField = (json as { error?: unknown }).error;
  if (errorField !== undefined && errorField !== null) {
    throw new Error(`LLM error: ${llmErrorMessage(errorField)}`);
  }
  const usageRaw = (json as { usage?: unknown }).usage;
  if (usageRaw && typeof usageRaw === 'object') {
    const usage = usageRaw as Record<string, unknown>;
    const prompt = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined;
    const completion = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined;
    const total = typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined;
    if (prompt !== undefined || completion !== undefined) {
      const cached = readCachedTokens(usage);
      acc.usage = {
        promptTokens: prompt ?? 0,
        completionTokens: completion ?? 0,
        totalTokens: total ?? (prompt ?? 0) + (completion ?? 0),
        ...(cached === undefined ? {} : { cachedTokens: cached }),
      };
    }
  }
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return {};
  const choice = choices[0] as {
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      /** DeepSeek reasoner 等兼容端点的思考链增量。 */
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  };
  if (choice.finish_reason) acc.finish = choice.finish_reason;
  const delta = choice.delta;
  if (!delta) return {};
  let textDelta: string | undefined;
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
    acc.thinking += delta.reasoning_content;
  }
  if (typeof delta.content === 'string' && delta.content.length > 0) {
    acc.text += delta.content;
    textDelta = delta.content;
  }
  for (const call of delta.tool_calls ?? []) {
    const index = call.index ?? 0;
    const current = acc.tools.get(index) ?? { id: '', name: '', arguments: '' };
    if (call.id) current.id = call.id;
    if (call.function?.name) current.name += call.function.name;
    if (call.function?.arguments) current.arguments += call.function.arguments;
    acc.tools.set(index, current);
  }
  return { textDelta };
}

export function finishStream(acc: SseAcc): StreamDelta {
  const toolCalls = [...acc.tools.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, call], i) => ({
      id: call.id || `call_${i}`,
      name: call.name,
      arguments: call.arguments,
    }));
  return {
    text: acc.text,
    thinking: acc.thinking || undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
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
export function buildRequestBody(options: RequestBodyOptions): Record<string, unknown> {
  return {
    model: options.model,
    messages: options.messages.map(serializeMessage),
    tools: options.tools.length > 0 ? options.tools : undefined,
    stream: true,
    stream_options: { include_usage: true },
    reasoning_effort: options.reasoningEffort && options.reasoningEffort !== 'off' ? options.reasoningEffort : undefined,
    // 上限仅在显式配置时发送；undefined 会被 JSON.stringify 丢弃，输出上限交还端点。
    max_tokens: options.maxTokens,
  };
}

export const openaiAdapter: ProtocolAdapter = {
  path: '/chat/completions',
  headers: (apiKey) => ({ 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }),
  buildBody: (input) => JSON.stringify(buildRequestBody(input)),
  apply: applySsePayload,
};
