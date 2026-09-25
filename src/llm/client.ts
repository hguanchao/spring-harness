/**
 * 模型客户端接缝。三种协议的实现在 sph-llm，循环和宿主只依赖这一面。
 */

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /**
   * 命中提示缓存的输入 token 数（可选：不是所有端点都上报）。
   * 约定 promptTokens 是含缓存的总输入量，各协议在适配层归一化。
   */
  cachedTokens?: number;
  /**
   * 本次调用的美元花费。models.json 声明了模型 `cost` 才会出现：
   * 由 client 在响应出口按（未缓存输入 × input + 缓存 × cacheRead + 输出 × output）折算。
   */
  costUsd?: number;
}

/**
 * 每百万 token 的美元单价（models.json 模型级 `cost` 字段）。
 *
 * `cacheWrite` 在 sph 的用量粒度里没有对应的 token 数（上游不区分上报短/长写），
 * 先声明、暂不参与折算——等哪天用量粒度跟上了再启用，声明了也不亏。
 */
export interface ModelCostRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** 一次调用的美元花费。cachedTokens 是 promptTokens 的子集，超出部分按 0 处理。 */
export function costUsd(usage: TokenUsage, rates: ModelCostRates): number {
  const cached = Math.min(Math.max(0, usage.cachedTokens ?? 0), Math.max(0, usage.promptTokens));
  const uncachedInput = Math.max(0, usage.promptTokens) - cached;
  return (
    (uncachedInput * rates.input + cached * rates.cacheRead + Math.max(0, usage.completionTokens) * rates.output)
    / 1_000_000
  );
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  /**
   * PDF 等文档附件：url 是 data URL（media type 在其中）。chat.completions 没有对应
   * 的线上形态，序列化时降级成一条给模型的说明文本；Responses / Anthropic 分别映射
   * 为 input_file / document source。
   */
  | { type: 'document'; document: { filename: string; url: string } };

/** Responses 推理项：下一轮必须原样回传 encrypted_content，否则模型跨步丢思考状态。 */
export interface ReasoningItem {
  id: string;
  encryptedContent?: string;
  summary?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** 仅 user 消息使用：与 content 一起序列化为多模态 parts。 */
  parts?: ContentPart[];
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  reasoning?: ReasoningItem[];
  /** Anthropic thinking 块回放：思考全文 + 签名。 */
  thinking?: string;
  thinkingSignature?: string;
}

export interface StreamDelta {
  text?: string;
  /** 推理模型暴露的思考链。 */
  thinking?: string;
  /** Anthropic thinking 块签名：跨步回放时必须原样带回。 */
  thinkingSignature?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  reasoning?: ReasoningItem[];
  finishReason?: string;
  usage?: TokenUsage;
}

export interface LlmRetryInfo {
  attempt: number;
  message: string;
  /**
   * `compat` = 按 400 报文剥字段再发。
   * `transport` = 瞬时传输失败，界面需要看见正在重试。
   */
  kind?: 'compat' | 'transport';
  /** 本跳的重试预算上限（不含首次）。 */
  maxRetries?: number;
}

export interface LlmClient {
  complete(
    messages: ChatMessage[],
    tools: unknown[],
    signal?: AbortSignal,
    onDelta?: (delta: { text?: string; thinking?: string }) => void,
    onRetry?: (info: LlmRetryInfo) => void,
  ): Promise<StreamDelta>;
}

/** 推理力度档位：off 表示不发送 reasoning_effort，走端点默认。 */
export const REASONING_EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** 传输层默认重试次数（不含首次）。config.toml `max_retries` 未写时用这个。 */
export const DEFAULT_MAX_RETRIES = 10;

/** 超长工具结果落盘的默认阈值（字符）。低于它的结果留在上下文里更划算。 */
export const DEFAULT_SPILL_THRESHOLD = 8 * 1024;
