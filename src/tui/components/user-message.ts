/**
 * 用户消息块：左侧竖线 + 浅中性灰底 `#2c2c2c`，在黑底终端上把用户输入从正文里抬出来。
 */

import {
  BLOCK_GAP,
  Box,
  Container,
  Markdown,
  type MarkdownTheme,
  Spacer,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '../core/index.js';
import { truncateToWidth, visibleWidth, wrapOsc133Zones } from '../core/utils.js';
import { getMarkdownTheme, theme } from '../theme/theme.js';
import { STICKY_USER_MESSAGE } from './sticky-user-message.js';

/** 左边框占用 1 列，把宽度和鼠标 x 交给内层时扣掉。 */
class LeftRuleBox implements Component {
  constructor(
    private readonly inner: Component,
    private readonly paint: (ch: string) => string,
  ) {}

  invalidate(): void {
    this.inner.invalidate?.();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.inner.handleMouse?.({
      ...event,
      x: event.x - 1,
      width: Math.max(1, event.width - 1),
    });
  }

  render(width: number): string[] {
    const rule = this.paint('┃');
    return this.inner.render(Math.max(1, width - 1)).map((line) => rule + line);
  }
}

export class UserMessageComponent extends Container {
  readonly [STICKY_USER_MESSAGE] = true as const;
  private readonly markdown: Markdown;

  constructor(text: string, markdownTheme: MarkdownTheme = getMarkdownTheme(), outputPad = 2) {
    super();
    this.markdown = new Markdown(text, 0, 0, markdownTheme, {
      color: (content: string) => theme.fg('userMessageText', content),
    });
    const contentBox = new Box(outputPad, 1, (content: string) => theme.bg('userMessageBg', content));
    contentBox.addChild(this.markdown);
    this.addChild(new Spacer(BLOCK_GAP));
    this.addChild(new LeftRuleBox(contentBox, (ch) => theme.fg('primary', ch)));
  }

  setText(text: string): void {
    this.markdown.setText(text);
  }

  /**
   * 吸顶只钉气泡，不带块前的 BLOCK_GAP。
   * `maxHeight` 小于全文时按 Box 的上下 pad 截正文，末行加省略号——钉的是提示开头。
   */
  renderSticky(width: number, maxHeight?: number): string[] {
    const bubble = this.children[this.children.length - 1];
    if (!bubble) return [];
    const lines = bubble.render(width);
    if (maxHeight === undefined || lines.length <= maxHeight) return lines;
    const height = Math.max(0, Math.floor(maxHeight));
    if (height === 0) return [];

    // LeftRuleBox > Box(paddingY=1)：首/末行是灰底 pad，中间才是正文。
    const pad = 1;
    const top = lines.slice(0, Math.min(pad, height));
    if (height <= pad) return top;
    const keepBottom = height > pad * 2;
    const bottom = keepBottom ? lines.slice(Math.max(pad, lines.length - pad)) : [];
    const contentBudget = height - top.length - bottom.length;
    const content = lines.slice(pad, Math.max(pad, lines.length - pad));
    const clipped = content.slice(0, contentBudget);
    if (content.length > clipped.length && clipped.length > 0) {
      const last = clipped[clipped.length - 1]!;
      const lineWidth = Math.max(1, visibleWidth(last) || width);
      clipped[clipped.length - 1] = truncateToWidth(last, lineWidth, ' …', true);
    }
    return [...top, ...clipped, ...bottom];
  }

  override render(width: number): string[] {
    return wrapOsc133Zones(super.render(width));
  }
}
