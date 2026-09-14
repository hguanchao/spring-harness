/**
 * 按「视觉行」（即考虑折行后的行）截断文本。
 *
 * 工具输出与 bash 输出共用，保证预览行数在不同宽度下表现一致。
 */

import { Text } from '../core/index.js';

export interface VisualTruncateResult {
  /** 实际展示的视觉行。 */
  visualLines: string[];
  /** 被隐藏的视觉行数。 */
  skippedCount: number;
}

/**
 * 从末尾保留最多 maxVisualLines 行。
 *
 * @param paddingX Text 组件的水平内边距。结果放进 Box 时用 0（Box 自带内边距），
 *                 直接放进 Container 时用 1。
 */
export function truncateToVisualLines(
  text: string,
  maxVisualLines: number,
  width: number,
  paddingX = 0,
): VisualTruncateResult {
  if (!text) return { visualLines: [], skippedCount: 0 };

  const allVisualLines = new Text(text, paddingX, 0).render(width);
  if (allVisualLines.length <= maxVisualLines) return { visualLines: allVisualLines, skippedCount: 0 };

  return {
    visualLines: allVisualLines.slice(-maxVisualLines),
    skippedCount: allVisualLines.length - maxVisualLines,
  };
}
