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
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

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
