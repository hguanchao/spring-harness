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

/**
 * 判定一段错误文本是否表示上下文超限。
 *
 * 刻意不把「413」单独当判据：413 是通用「载荷过大」，一张超限图片也会触发，
 * 对它做压缩重试纯属浪费一次调用。413 只有在正文命中措辞时才归类。
 */
export function looksLikeContextOverflow(text: string): boolean {
  const lower = text.toLowerCase();
  return OVERFLOW_PATTERNS.some((pattern) => lower.includes(pattern));
}

/** 供各协议的 error 抛出点共用：命中超限措辞就产出专用错误类型。 */
export function llmError(prefix: string, message: string): Error {
  return looksLikeContextOverflow(message) ? new ContextOverflowError(`${prefix}: ${message}`) : new Error(`${prefix}: ${message}`);
}
