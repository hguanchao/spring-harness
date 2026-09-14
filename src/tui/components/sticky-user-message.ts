/**
 * 转录视口里的用户消息吸顶：滚过某条用户气泡后，把它钉在 ScrollView 顶部，
 * 下一条用户消息到来时把前一条顶走。自管视口上的软件吸顶，不是终端原生 sticky。
 */

import { getScrollViewBox, type LayoutBox, type LayoutFrame } from '../core/layout.js';
import { compositeTuiLine, type Component } from '../core/tui.js';

export const STICKY_USER_MESSAGE = Symbol.for('sph.sticky-user-message');

export interface StickyUserMessage extends Component {
  readonly [STICKY_USER_MESSAGE]: true;
  renderSticky(width: number): string[];
}

function isStickyUserMessage(component: Component): component is StickyUserMessage {
  return (component as StickyUserMessage)[STICKY_USER_MESSAGE] === true;
}

function collectStickyBoxes(box: LayoutBox, out: LayoutBox[]): void {
  if (isStickyUserMessage(box.component)) out.push(box);
  for (const child of box.children) collectStickyBoxes(child, out);
}

function bubbleTop(box: LayoutBox): number {
  return box.rect.y;
}

export function compositeStickyUserMessages(screen: string[], frame: LayoutFrame, width: number): string[] {
  const scrollView = frame.primaryScrollView;
  if (!scrollView) return screen;
  const scrollBox = getScrollViewBox(frame, scrollView);
  if (!scrollBox || scrollBox.clip.width <= 0 || scrollBox.clip.height <= 0) return screen;

  const messages: LayoutBox[] = [];
  for (const child of scrollBox.children) collectStickyBoxes(child, messages);
  if (messages.length === 0) return screen;

  const viewportTop = scrollBox.clip.y;
  const viewportBottom = scrollBox.clip.y + scrollBox.clip.height;
  let sticky: LayoutBox | undefined;
  let nextBubble = Number.POSITIVE_INFINITY;
  for (let index = 0; index < messages.length; index++) {
    const box = messages[index]!;
    if (bubbleTop(box) < viewportTop) {
      sticky = box;
      nextBubble = index + 1 < messages.length ? bubbleTop(messages[index + 1]!) : Number.POSITIVE_INFINITY;
    }
  }
  if (!sticky || !isStickyUserMessage(sticky.component)) return screen;
  if (bubbleTop(sticky) >= viewportTop) return screen;

  const overlay = sticky.component.renderSticky(Math.max(1, sticky.rect.width));
  if (overlay.length === 0) return screen;

  let pinTop = viewportTop;
  if (pinTop + overlay.length > nextBubble) pinTop = nextBubble - overlay.length;
  if (pinTop + overlay.length <= viewportTop) return screen;

  const result = [...screen];
  const first = Math.max(pinTop, viewportTop);
  const last = Math.min(pinTop + overlay.length, viewportBottom, result.length);
  for (let row = first; row < last; row++) {
    const line = overlay[row - pinTop];
    if (line === undefined) continue;
    result[row] = compositeTuiLine(result[row] ?? '', line, scrollBox.clip.x, scrollBox.clip.width, width);
  }
  return result;
}
