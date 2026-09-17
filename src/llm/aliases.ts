/**
 * 响应字段并集。
 *
 * 请求侧未知字段会 400，所以要少发；响应侧多读一个空键几乎免费，少读一个
 * 就是 TUI 停在 Working…（中转站写 `delta.reasoning`、官方写 `reasoning_content`）。
 *
 * 只覆盖「同一个 JSON 对象上换了键名」。Anthropic / Responses 靠事件 type 分路，
 * 不把协议事件表塞进这里。
 */

export const THINKING_KEYS = ['reasoning_content', 'reasoning', 'thinking'] as const;
export const TEXT_KEYS = ['content', 'text'] as const;
export const PROMPT_TOKEN_KEYS = ['prompt_tokens', 'input_tokens'] as const;
export const COMPLETION_TOKEN_KEYS = ['completion_tokens', 'output_tokens'] as const;
export const TOTAL_TOKEN_KEYS = ['total_tokens'] as const;

export function firstString(row: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

export function firstFiniteNumber(row: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}
