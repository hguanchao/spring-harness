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
import { wrapOsc133Zones } from '../core/utils.js';
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

  /** 吸顶只钉气泡，不带块前的 BLOCK_GAP，避免视口顶上先空一行。 */
  renderSticky(width: number): string[] {
    const bubble = this.children[this.children.length - 1];
    return bubble ? bubble.render(width) : [];
  }

  override render(width: number): string[] {
    return wrapOsc133Zones(super.render(width));
  }
}
