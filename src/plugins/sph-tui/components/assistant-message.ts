/**
 * 助手消息块：回答正文。
 *
 * 思考链不再由本块承载——它作为成员行并入工具分组（见 ToolGroupComponent.setThinking），
 * 与同一步的工具调用共享折叠/展开语义；本块只管正文。
 *
 * sph 的流式事件是 text 增量，因此组件按累积值重建。重建会新建 Markdown 组件，等于把框架
 * Markdown 的「按宽度缓存解析结果」丢掉——流式期间每帧都要把累计全文重新解析一遍。实测该
 * 代价接近 O(文本长度 × 帧数)：3830 字符 / 320 增量要 137ms。所以 setter 只标脏，同一帧内的
 * 多次增量在 render(width) 里合并成一次重建。
 */

import { BLOCK_GAP, Container, Markdown, type MarkdownTheme, Spacer } from '../../../tui/index.js';
import { wrapOsc133Zones } from '../../../tui/utils.js';
import { getMarkdownTheme, theme } from '../theme/theme.js';

/** 对齐 opencode TextPart 的 paddingLeft=3。 */
const DEFAULT_OUTPUT_PAD = 3;

export class AssistantMessageComponent extends Container {
  private readonly contentContainer: Container;
  private readonly markdownTheme: MarkdownTheme;
  private readonly outputPad: number;
  /** 正文 Markdown 跨帧复用：流式增量只 setText，避免每帧丢掉宽度缓存。 */
  private bodyMarkdown: Markdown | undefined;

  private text = '';
  private isStreaming = false;
  private dirty = true;

  constructor(options: { markdownTheme?: MarkdownTheme; outputPad?: number } = {}) {
    super();
    this.markdownTheme = options.markdownTheme ?? getMarkdownTheme();
    this.outputPad = options.outputPad ?? DEFAULT_OUTPUT_PAD;
    this.contentContainer = new Container();
    this.addChild(this.contentContainer);
  }

  /** 整体替换正文（权威值）。 */
  setText(text: string): void {
    this.text = text;
    this.markDirty();
  }

  appendText(delta: string): void {
    this.text += delta;
    this.markDirty();
  }

  setStreaming(streaming: boolean): void {
    this.isStreaming = streaming;
  }

  get streaming(): boolean {
    return this.isStreaming;
  }

  /** 标记内容已变化；真正的重建发生在下一次 render(width)。 */
  private markDirty(): void {
    this.dirty = true;
  }

  private rebuild(): void {
    this.contentContainer.clear();

    const body = this.text.trim();
    if (body === '') return;

    this.contentContainer.addChild(new Spacer(BLOCK_GAP));
    if (this.bodyMarkdown) {
      this.bodyMarkdown.setText(body);
    } else {
      this.bodyMarkdown = new Markdown(body, this.outputPad, 0, this.markdownTheme, {
        color: (content: string) => theme.fg('mdText', content),
      });
    }
    this.contentContainer.addChild(this.bodyMarkdown);
  }

  override invalidate(): void {
    // 框架要求「清缓存后下次 render 从头重建」——正好与脏标记同义。
    this.markDirty();
  }

  override render(width: number): string[] {
    // 同一帧内累积的多次增量在这里合并成一次重建。
    if (this.dirty) {
      this.dirty = false;
      this.rebuild();
    }
    return wrapOsc133Zones(super.render(width));
  }
}
