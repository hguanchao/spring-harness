/**
 * 跨模块的无状态小工具。
 *
 * 只放「与业务域无关、至少两处同构」的函数，避免每个目录再复制一份
 * `error instanceof Error` / `isRecord` / 空白折叠。
 */

/** 把 unknown 收成可读的错误正文；非 Error 走 String()，与历史调用点逐字一致。 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Node `fetch` 失败时常只给 `fetch failed`，真正原因在 `error.cause`（ECONNRESET、
 * UND_ERR_CONNECT_TIMEOUT、证书）。沿 cause 链拼出来，状态行才看得出是代理还是 TLS。
 */
export function formatFetchError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    const code = 'code' in current && typeof current.code === 'string' ? current.code : undefined;
    const piece = code && !current.message.includes(code) ? `${current.message} (${code})` : current.message;
    if (piece && !parts.some((existing) => existing.includes(piece))) parts.push(piece);
    current = current.cause;
  }
  return parts.join(' → ') || String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 连续空白压成单空格并去掉首尾，用于预览/摘要/单行展示。 */
export function flattenWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 时长的紧凑显示：一分钟内 `43.2s`，以上 `2m13s`。
 *
 * 工具分组（思考链耗时）、子代理活动行共用。状态行的阶段/本轮耗时走
 * {@link formatStatusElapsed}：10s 以上不再带小数，避免一行上两个时钟都在跳十分位。
 */
export function formatDuration(ms: number): string {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds - minutes * 60);
  return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
}

/**
 * 状态行时钟：阶段耗时与本轮耗时同一套粒度。
 *
 * 10s 以内留一位小数（`2.9s`），之上取整（`17s` / `1m20s` / `1h2m`）。
 * 和 footer 的累计时长分开，是因为状态行两个时钟并排，十分位连跳会抢注意力。
 */
export function formatStatusElapsed(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) {
    const rounded = Math.round(seconds);
    return rounded === 60 ? '1m0s' : `${rounded}s`;
  }
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const rest = Math.round(seconds - minutes * 60);
    if (rest === 60) return `${minutes + 1}m0s`;
    return `${minutes}m${rest}s`;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds - hours * 3600) / 60);
  if (minutes === 60) return `${hours + 1}h0m`;
  return `${hours}h${minutes}m`;
}

/**
 * 状态行右侧的上下文 token 缩写：`1.47k` / `10.1k` / `147k` / `1.47m`。
 *
 * footer 的 `formatTokens` 是水位展示（一位小数、大写 M）；这里跟在本轮耗时后面，
 * 需要更紧、和截图里 `↓1.47k` 同一数量级，所以单独一套。
 */
export function formatStatusTokens(count: number): string {
  if (count < 1000) return String(Math.round(count));
  if (count < 10_000) return `${(count / 1000).toFixed(2)}k`;
  if (count < 100_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(2)}m`;
  return `${(count / 1_000_000).toFixed(1)}m`;
}

/**
 * 文件名/标识消毒：非法字符变 `_`，空串回落到 fallback。
 * spill 文件名与会话目录 leaf 共用同一字符类，避免两套规则漂移。
 */
export function sanitizeIdent(name: string, max: number, fallback = ''): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, max);
  return cleaned === '' ? fallback : cleaned;
}

/** 转义正则元字符，把外部输入安全地拼进 RegExp 字面量。 */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
