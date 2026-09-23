import type { SessionAffinityFormat } from './compat.js';

/**
 * OpenAI 系端点的提示缓存参数。
 *
 * 与 Anthropic 的分工不同：OpenAI / Azure / 各兼容端点的前缀缓存是**自动**的，没有
 * `cache_control` 那样的断点可打。客户端能做的只有两件事：
 *
 * 1. **把同一会话的请求导到同一台机器上。** 缓存是每台机器各自维护的，同一段前缀分散
 *    到 N 台机器上，等于每台都各存一份、命中率被摊薄 N 倍。`prompt_cache_key` 与几个
 *    会话亲和头就是干这个的。
 * 2. **让缓存活得久一点。** `prompt_cache_retention: "24h"` 明确要求延长保留时间。
 *    读缓存不额外收费，所以这是纯上行的收益；端点不认时会由 `compat.ts` 的降级机制撤掉。
 *
 * 另外 `prompt_cache_key` 官方限长 64 个字符，超长会被拒——用 `Array.from` 按**码点**
 * 截断，而不是 `slice`，否则代理对（emoji、部分 CJK 扩展字）会被从中间劈开，得到两个
 * 非法码位。
 */

/** OpenAI 对 `prompt_cache_key` 的长度上限（字符，非字节）。 */
export const PROMPT_CACHE_KEY_MAX_LENGTH = 64;

/** 明确要求延长保留时间时发送的值。 */
export const PROMPT_CACHE_RETENTION = '24h';

export function clampPromptCacheKey(key: string | undefined): string | undefined {
  if (key === undefined) return undefined;
  const chars = Array.from(key);
  if (chars.length <= PROMPT_CACHE_KEY_MAX_LENGTH) return key;
  return chars.slice(0, PROMPT_CACHE_KEY_MAX_LENGTH).join('');
}

/**
 * 会话亲和的追加请求头。
 *
 * `session_id` / `x-client-request-id` / `x-session-affinity` 是 OpenAI 形态端点常见的
 * 三个名字；OpenRouter 认的是 `x-session-id`。格式由 URL 推断或 `[compat].session_affinity`
 * 覆盖，adapter 只负责按格式填头。
 *
 * 只挂在 OpenAI 系 adapter 上：Anthropic 的缓存按账号 + 前缀计，没有这类头。
 */
export function openaiSessionHeaders(sessionId: string, format: SessionAffinityFormat): Record<string, string> {
  if (format === 'off') return {};
  if (format === 'openrouter') return { 'x-session-id': sessionId };
  return {
    session_id: sessionId,
    'x-client-request-id': sessionId,
    'x-session-affinity': sessionId,
  };
}
