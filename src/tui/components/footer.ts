/**
 * 底部状态栏：项目、分支、模型、effort、上下文水位与缓存命中率，单行分段展示。
 *
 * 每段带 emoji 前缀、用 | 分隔；上下文段按用量水位变色（越接近上限越醒目），其余段 dim。
 */

import { type Component, visibleWidth } from '../core/index.js';
import { theme } from '../theme/theme.js';

export interface FooterUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

export interface FooterData {
  cwd: string;
  gitBranch?: string;
  model: string;
  /** 推理强度（未启用则省略）。 */
  effort?: string;
  contextWindow: number;
  /** 最近一次请求的上下文 token 数（水位），未知为 undefined。 */
  contextTokens?: number;
  usage: FooterUsage;
}

export interface ReadonlyFooterDataProvider {
  get(): FooterData;
}

/** 紧凑的 token 计数展示。 */
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

export class FooterComponent implements Component {
  constructor(private readonly data: ReadonlyFooterDataProvider) {}

  invalidate(): void {
    // 每帧从 provider 取数，无需缓存。
  }

  render(width: number): string[] {
    const data = this.data.get();
    // 项目名称取 workspaceRoot 最后一段；Windows 反斜杠归一后再切。
    const normalized = data.cwd.replace(/\\/g, '/').replace(/\/+$/, '');
    const projectName = normalized.split('/').pop() || data.cwd;

    // 各段独立上色再拼接：已带色的段外层再套 dim 会被其中的 reset 清掉。
    const parts: string[] = [];
    const push = (icon: string, text: string, color: 'dim' | 'warning' | 'error' = 'dim'): void => {
      parts.push(theme.fg(color, `${icon} ${text}`));
    };

    push('📁', projectName);
    if (data.gitBranch) push('🌿', data.gitBranch);
    push('🤖', data.model);
    if (data.effort) push('🧠', data.effort);

    // 上下文水位：用量/窗口。用量越高颜色越醒目，压力临近时第一眼可见。
    const percent =
      data.contextTokens !== undefined && data.contextWindow > 0
        ? (data.contextTokens / data.contextWindow) * 100
        : undefined;
    const contextText = `${data.contextTokens !== undefined ? formatTokens(data.contextTokens) : '?'} / ${formatTokens(data.contextWindow)}`;
    const contextColor = percent === undefined || percent <= 70 ? 'dim' : percent > 90 ? 'error' : 'warning';
    push('🧮', contextText, contextColor);

    // 缓存命中率：promptTokens 在协议层已归一化为「含缓存的总输入」，所以
    // 命中率 = cachedTokens / promptTokens。取会话累计口径——与各协议的归一化一致，
    // 且不像单次请求那样逐轮跳动。端点从未报告过缓存用量时整段省略，0% 只是噪音。
    if (data.usage.cachedTokens > 0 && data.usage.promptTokens > 0) {
      const hitRate = Math.round((data.usage.cachedTokens / data.usage.promptTokens) * 100);
      push('⚡', `${hitRate}%`);
    }

    // 超宽时从尾部丢段而不是字符级截断：状态栏按段阅读，截断会把 emoji 切成乱码。
    const separator = theme.fg('dim', ' | ');
    const separatedWidth = visibleWidth(separator);
    const widths = parts.map((part) => visibleWidth(part));
    let segments = parts.length;
    let total = widths.reduce((sum, w) => sum + w, 0) + separatedWidth * Math.max(0, segments - 1);
    while (total > width && segments > 1) {
      segments -= 1;
      total -= widths[segments] + separatedWidth;
    }
    return [parts.slice(0, segments).join(separator)];
  }
}
