/**
 * 底部状态栏：项目、审批、模型、上下文水位。四段都带 emoji。
 *
 * 缓存命中和花费不在这行：百分比贴在水位旁边会被读成「上下文快满了」。
 * 窗口变窄时先丢掉项目，再丢掉模型；审批和水位留到最后。
 */

import { type Component, visibleWidth } from '@/tui/index.js';
import type { ApprovalMode } from '@/permission/policy.js';
import { theme, type ThemeColor } from '@/plugins/sph-tui/theme/theme.js';

export interface FooterData {
  cwd: string;
  gitBranch?: string;
  /** 当前代理定义名。空或省略表示默认全工具，跟项目写在同一段里。 */
  agent?: string;
  /** 审批模式。头会滚走，这行是它一直在的地方。 */
  approval: ApprovalMode;
  model: string;
  /** 推理强度（未启用则省略），跟模型写在同一段里。 */
  effort?: string;
  contextWindow: number;
  /** 最近一次请求的上下文 token 数（水位），未知为 undefined。 */
  contextTokens?: number;
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

function approvalColor(mode: ApprovalMode): ThemeColor {
  if (mode === 'yolo') return 'error';
  if (mode === 'auto') return 'warning';
  return 'primary';
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

    const project = ['📁', projectName];
    if (data.gitBranch) project.push('🌿', data.gitBranch);
    if (data.agent) project.push('🧩', data.agent);

    const model = ['🤖', data.model];
    if (data.effort) model.push('🧠', data.effort);

    const percent =
      data.contextTokens !== undefined && data.contextWindow > 0
        ? (data.contextTokens / data.contextWindow) * 100
        : undefined;
    const contextText = `${data.contextTokens !== undefined ? formatTokens(data.contextTokens) : '0.0k'} / ${formatTokens(data.contextWindow)}`;
    const contextColor: ThemeColor = percent === undefined || percent <= 70 ? 'dim' : percent > 90 ? 'error' : 'warning';

    // 各段独立上色再拼接：已带色的段外层再套 dim 会被其中的 reset 清掉。
    // droppable 的段先丢。审批和水位不是，窄到只剩它们才从左再丢。
    const segments = [
      { text: theme.fg('dim', project.join(' ')), droppable: true },
      { text: theme.fg(approvalColor(data.approval), `🛡️ ${data.approval}`), droppable: false },
      { text: theme.fg('dim', model.join(' ')), droppable: true },
      { text: theme.fg(contextColor, `🧮 ${contextText}`), droppable: false },
    ];
    return [fitFooter(segments, width)];
  }
}

function fitFooter(segments: Array<{ text: string; droppable: boolean }>, width: number): string {
  const visible = segments.slice();
  const separator = theme.fg('dim', ' | ');
  const separatedWidth = visibleWidth(separator);
  const widthOf = (items: typeof visible): number => {
    const body = items.reduce((sum, item) => sum + visibleWidth(item.text), 0);
    return body + separatedWidth * Math.max(0, items.length - 1);
  };
  while (widthOf(visible) > width && visible.some((item) => item.droppable)) {
    const index = visible.findIndex((item) => item.droppable);
    visible.splice(index, 1);
  }
  while (widthOf(visible) > width && visible.length > 1) visible.shift();
  return visible.map((item) => item.text).join(separator);
}
