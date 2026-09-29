/**
 * 转录视口里的用户消息吸顶。
 *
 * 滚过某条用户气泡后把它钉在视口顶，
 * 高度随滚动 1:1 收缩到最小截断高度；下一条用户消息靠近时从顶部把前一条顶走。
 * 自管视口上的软件吸顶，不是终端原生 sticky。
 */

import { BLOCK_GAP } from '@/tui/widgets/primitives.js';
import { contentPaintRight, getScrollViewBox, type LayoutBox, type LayoutFrame } from '@/tui/screen/layout.js';
import { compositeTuiLine, type Component } from '@/tui/screen/tui.js';

export const STICKY_USER_MESSAGE = Symbol.for('sph.sticky-user-message');

/** 吸顶截断后的最大行数：上/下各 1 行 pad + 3 行正文。 */
export const MAX_STICKY_HEIGHT = 5;

/** 吸顶块与下一条用户气泡之间预留的 1 行空隙，顶走判定用。 */
export const HEADER_CONTENT_GAP = 1;

/**
 * 用户消息 LayoutBox 的首行是块前空隙，不是气泡。
 * pin-reserve / 滚到该条 必须钉气泡顶，否则视口顶先空一行，跟 overlay 吸顶差 1 行。
 */
export function userMessageBubbleY(componentTop: number): number {
  return componentTop + BLOCK_GAP;
}

export interface StickyUserMessage extends Component {
  readonly [STICKY_USER_MESSAGE]: true;
  renderSticky(width: number, maxHeight?: number, ellipsis?: boolean): string[];
}

export interface PromptDescriptor {
  index: number;
  yVirtual: number;
  fullHeight: number;
  minHeight: number;
  sticky: boolean;
}

export interface RenderedPrompt {
  index: number;
  renderHeight: number;
  clipTop: number;
  /** 已经收到最小高度。收缩途中只切行，到这里才在末行加省略号。 */
  ellipsis: boolean;
}

export interface StickyHeaderLayout {
  pushed?: RenderedPrompt;
  pinned?: RenderedPrompt;
}

export function isStickyUserMessage(component: Component): component is StickyUserMessage {
  return (component as StickyUserMessage)[STICKY_USER_MESSAGE] === true;
}

function collectStickyBoxes(box: LayoutBox, out: LayoutBox[]): void {
  if (isStickyUserMessage(box.component)) out.push(box);
  for (const child of box.children) collectStickyBoxes(child, out);
}

/**
 * 用户消息块前面有 BLOCK_GAP 空行，吸顶只钉气泡本身。
 * UserMessageComponent 是 layout 叶子，子 Spacer 没有独立 LayoutBox，只能按约定扣。
 */
function bubbleMetrics(box: LayoutBox): { y: number; height: number } {
  const lead = Math.min(BLOCK_GAP, Math.max(0, box.rect.height));
  return { y: box.rect.y + lead, height: Math.max(0, box.rect.height - lead) };
}

function stickyMetrics(
  prompt: PromptDescriptor,
  scrollOffset: number,
  viewportHeight: number,
): { renderHeight: number; ellipsis: boolean } {
  const scrollPast = Math.max(0, scrollOffset - prompt.yVirtual);
  const raw = Math.max(0, prompt.fullHeight - scrollPast);
  const minHeight = Math.min(Math.max(prompt.minHeight, 1), Math.max(prompt.fullHeight, 1));
  const renderHeight = Math.min(Math.max(raw, minHeight), Math.max(0, viewportHeight));
  return { renderHeight, ellipsis: raw < minHeight };
}

/**
 * 纯 1D 吸顶布局。`prompts` 必须按 `yVirtual` 升序。
 * 坐标系任意，只要 `scrollOffset` 与 `yVirtual` 同一套（内容坐标或屏幕坐标）。
 */
export function computeStickyLayout(
  scrollOffset: number,
  viewportHeight: number,
  prompts: readonly PromptDescriptor[],
): StickyHeaderLayout {
  if (prompts.length === 0 || scrollOffset <= 0) return {};

  let pinnedIdx = -1;
  for (let index = prompts.length - 1; index >= 0; index--) {
    const prompt = prompts[index]!;
    // 刚好贴住视口顶也算吸住。用「已经滚过」会在这一行把上一条撤掉、下一条还没钉上。
    if (prompt.sticky && prompt.yVirtual <= scrollOffset) {
      pinnedIdx = index;
      break;
    }
  }
  if (pinnedIdx < 0) return {};

  const pinnedPrompt = prompts[pinnedIdx]!;
  const metrics = stickyMetrics(pinnedPrompt, scrollOffset, viewportHeight);
  const next = pinnedIdx + 1 < prompts.length ? prompts[pinnedIdx + 1] : undefined;
  if (!next) {
    return { pinned: { index: pinnedPrompt.index, renderHeight: metrics.renderHeight, clipTop: 0, ellipsis: metrics.ellipsis } };
  }

  const nextNaiveRow = Math.max(0, next.yVirtual - scrollOffset);
  if (nextNaiveRow > metrics.renderHeight + HEADER_CONTENT_GAP) {
    return { pinned: { index: pinnedPrompt.index, renderHeight: metrics.renderHeight, clipTop: 0, ellipsis: metrics.ellipsis } };
  }
  if (nextNaiveRow === 0) {
    return { pinned: { index: next.index, renderHeight: Math.min(next.fullHeight, viewportHeight), clipTop: 0, ellipsis: false } };
  }

  const pushedVisible = Math.max(0, nextNaiveRow - 1);
  if (pushedVisible === 0) return {};

  const pushedRenderHeight = Math.min(pinnedPrompt.fullHeight, metrics.renderHeight);
  return {
    pushed: {
      index: pinnedPrompt.index,
      renderHeight: pushedRenderHeight,
      clipTop: Math.max(0, pushedRenderHeight - pushedVisible),
      ellipsis: false,
    },
  };
}

export function compositeStickyUserMessages(screen: string[], frame: LayoutFrame, width: number): string[] {
  const placement = stickyPlacement(frame);
  if (!placement) return screen;
  const result = [...screen];
  const last = Math.min(placement.y + placement.lines.length, result.length);
  for (let row = placement.y; row < last; row++) {
    const line = placement.lines[row - placement.y];
    if (line === undefined) continue;
    result[row] = compositeTuiLine(result[row] ?? '', line, placement.x, placement.width, width);
  }
  return result;
}

export interface StickyOverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 当前帧吸顶气泡占据的屏幕矩形。合成（画上去）与鼠标命中（别点穿）必须共用同一份
 * 计算：气泡是画在屏幕缓冲上的合成层，不在布局树里，命中判定若各自为政就会漂移。
 */
export function stickyOverlayRects(frame: LayoutFrame): StickyOverlayRect[] {
  const placement = stickyPlacement(frame);
  return placement ? [{ x: placement.x, y: placement.y, width: placement.width, height: placement.lines.length }] : [];
}

function stickyPlacement(frame: LayoutFrame): { x: number; y: number; width: number; lines: string[] } | undefined {
  const scrollView = frame.primaryScrollView;
  if (!scrollView) return undefined;
  const scrollBox = getScrollViewBox(frame, scrollView);
  if (!scrollBox || scrollBox.clip.width <= 0 || scrollBox.clip.height <= 0) return undefined;

  const messages: LayoutBox[] = [];
  for (const child of scrollBox.children) collectStickyBoxes(child, messages);
  if (messages.length === 0) return undefined;

  const viewportTop = scrollBox.clip.y;
  const viewportHeight = scrollBox.clip.height;
  // 子文档已按 -scrollTop 平移；换到内容坐标后，滚动量为 0 就可以直接短路。
  const originY = scrollBox.children[0]?.rect.y ?? scrollBox.rect.y;
  const scrollOffset = viewportTop - originY;
  const prompts: PromptDescriptor[] = [];
  for (let index = 0; index < messages.length; index++) {
    const { y, height } = bubbleMetrics(messages[index]!);
    if (height <= 0) continue;
    // fullHeight 必须是气泡真高：收缩期 header 每矮 1 行，正文就多露 1 行，
    // 视口底边不变。minHeight 才是截断上限。
    prompts.push({
      index,
      yVirtual: y - originY,
      fullHeight: height,
      minHeight: Math.min(height, MAX_STICKY_HEIGHT),
      sticky: true,
    });
  }

  const layout = computeStickyLayout(scrollOffset, viewportHeight, prompts);
  const rendered = layout.pinned ?? layout.pushed;
  if (!rendered) return undefined;

  const sticky = messages[rendered.index];
  if (!sticky || !isStickyUserMessage(sticky.component)) return undefined;

  // 吸顶停在滚动视口内，不盖滑块那一列，也不画出视口底。
  const contentRight = contentPaintRight(scrollBox);
  const overlayWidth = Math.max(1, Math.min(sticky.rect.width, contentRight - sticky.rect.x));
  const overlay = sticky.component.renderSticky(
    overlayWidth,
    rendered.clipTop > 0 ? undefined : rendered.renderHeight,
    rendered.ellipsis,
  );
  if (overlay.length === 0) return undefined;
  const visible = overlay.slice(rendered.clipTop).slice(0, viewportHeight);
  if (visible.length === 0) return undefined;
  return { x: sticky.rect.x, y: viewportTop, width: overlayWidth, lines: visible };
}
