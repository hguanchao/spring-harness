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
 * 工具分组（思考链耗时）、子代理活动行、状态行右侧耗时共用同一套写法。
 */
export function formatDuration(ms: number): string {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds - minutes * 60);
  return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
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
