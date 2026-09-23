/**
 * 上游「上下文超窗」错误的统一识别。
 *
 * 为什么需要单独一类错误：这是唯一一种「请求本身没错、重发一次也没用，但把上下文压小就能
 * 成功」的失败。重试策略（408/429/5xx）覆盖不到它，而普通 4xx 又该怎么失败就怎么失败——
 * 只有把它单独标出来，agent loop 才知道该压缩后重试，而不是把错误直接甩给用户。
 *
 * 三种协议的报文形态不一致，且中转站各有各的措辞，所以这里同时匹配
 * 「结构化错误码」与「自然语言措辞」两类信号，宁可漏判也不能误判成普通错误。
 */

import { RetryableError } from './retry.js';

/** provider 已确认上下文超限；调用方可压缩后重试。 */
export class ContextOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextOverflowError';
  }
}

/**
 * 措辞信号。全部小写匹配。
 *
 * 覆盖三家官方报文与常见网关：
 * - OpenAI: `context_length_exceeded` / "maximum context length is N tokens"
 * - Anthropic: "prompt is too long: N tokens > M maximum"
 * - Google/其他: "input is too long" / "exceeds the maximum number of tokens"
 * - 部分中转: "reduce the length of the messages"
 */
const OVERFLOW_PATTERNS = [
  'context_length_exceeded',
  'context length exceeded',
  'maximum context length',
  'exceeds the context window',
  'exceed context window',
  'context window exceeded',
  'prompt is too long',
  'input is too long',
  'too many tokens',
  'reduce the length of the messages',
  'maximum number of tokens',
  'exceeds the maximum',
];

const STRUCTURED_CONTEXT_OVERFLOW = /(?:^|[^a-z0-9])context[\s_-](?:length|window)[\s_-](?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)(?:$|[^a-z0-9])/i;
const TOO_LARGE_FOR_CONTEXT = /\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?(?:model(?:'s)?\s+)?context(?:\s+window)?\b/i;
const EXCEEDS_MODEL_CONTEXT = /\b(?:input|prompt|request|messages?)\b.{0,40}\b(?:exceed(?:s|ed)?|overflows?|is\s+larger\s+than)\b.{0,40}\b(?:the\s+)?(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?\b/i;

/**
 * 判定一段错误文本是否表示上下文超限。
 *
 * 刻意不把「413」单独当判据：413 是通用「载荷过大」，一张超限图片也会触发，
 * 对它做压缩重试纯属浪费一次调用。413 只有在正文命中措辞时才归类。
 * 结构化措辞里要认 `context_window_limit_exceeded`，否则超窗会被当成普通 400。
 */
export function looksLikeContextOverflow(text: string): boolean {
  const lower = text.toLowerCase();
  return OVERFLOW_PATTERNS.some((pattern) => lower.includes(pattern))
    || STRUCTURED_CONTEXT_OVERFLOW.test(text)
    || TOO_LARGE_FOR_CONTEXT.test(text)
    || EXCEEDS_MODEL_CONTEXT.test(text);
}

/** 额度用尽不是瞬时 429，重试没有意义。 */
export function looksLikeQuotaExceeded(text: string): boolean {
  return /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i.test(text)
    || /\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i.test(text)
    || /\bexceed(?:ed|s)?[\s_-]+(?:(?:your|the)[\s_-]+)?(?:current[\s_-]+)?quota\b/i.test(text)
    || /\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b/i.test(text)
    || /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i.test(text);
}

/**
 * HTTP 状态 → 稳定码：401/403 AUTH，429 RATE_LIMIT，
 * 5xx SERVER，400 超窗单独识别。额度用尽不当成可重试限流。
 */
export function classifyHttpError(status: number, detail: string): string {
  if (status === 401 || status === 403) return 'AUTH';
  if (looksLikeQuotaExceeded(detail)) return 'QUOTA';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 400 && looksLikeContextOverflow(detail)) return 'CONTEXT_WINDOW_EXCEEDED';
  if (status === 400 || status === 413) return 'INVALID_REQUEST';
  if (status >= 500) return 'SERVER';
  return `HTTP_${status}`;
}

/** 供各协议的 error 抛出点共用：命中超限措辞就产出专用错误类型。 */
export function llmError(prefix: string, message: string): Error {
  return looksLikeContextOverflow(message) ? new ContextOverflowError(`${prefix}: ${message}`) : new Error(`${prefix}: ${message}`);
}

/**
 * 流中途 error 帧里的终态措辞：命中说明重发同一请求也不会好，必须直接上抛。
 * 传输类失败（upstream disconnected / timeout / overloaded……）各家网关措辞五花八门，
 * 穷举白名单必然漏，所以只列终态黑名单，其余一律按传输抖动处理。
 */
const FATAL_STREAM_FRAME: RegExp[] = [
  /\bcontent[\s_-]?filter\b/i,
  /\bmoderation\b/i,
  /\bpolicy[\s_-]?(?:violation|error|blocked)\b/i,
  /\binvalid[_\s](?:api[_\s]?)?key\b/i,
  /\b(?:unauthorized|authentication|forbidden|permission)[_\s]?(?:error|denied)?\b/i,
  /\binvalid[_\s]request(?:[_\s]error)?\b/i,
  /\binvalid[_\s](?:parameter|param)\b/i,
  /\bunsupported[_\s]?(?:parameter|param|model|value|region|country)\b/i,
  /\bmodel[_\s]?(?:not[_\s]?(?:found|exist)|does[_\s]?not[_\s]?exist)\b/i,
  /审核/,
  /敏感(?:内容|词|信息)/,
  /违规/,
];

/**
 * 流中途收到 error 帧（HTTP 已 200）的统一分类。网关常把上游断流包成业务错误上报
 * （fengwind 的 "Upstream stream disconnected" 即此类），默认判为传输抖动交给
 * stream-client 丢半截退避重打；只有命中终态措辞（审核、鉴权、参数、额度、超窗）
 * 才按原语义上抛，否则会把审核拒绝当成网络抖动白打几轮。
 */
export function streamFrameError(prefix: string, message: string): Error {
  if (looksLikeContextOverflow(message) || looksLikeQuotaExceeded(message)) return llmError(prefix, message);
  if (FATAL_STREAM_FRAME.some((pattern) => pattern.test(message))) return llmError(prefix, message);
  return new RetryableError(`${prefix}: ${message}`);
}
