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
 *
 * 合并脏标记只解决了「一帧内多次增量」，没解决「每帧一次全量重解析」——解析代价随全文长度
 * 线性涨（8K 字 6.6ms / 32K 字 64ms / 82K 字 178ms，见 Markdown.setText 的注释），一份几十 K
 * 的回答边流边解析就是每帧百毫秒级，帧率掉到个位数。所以正文重解析还要按实测耗时自适应节流
 * （见 STREAM_REFRESH_MIN_MS）：允许过程滞后，收尾与权威 setText 不节流。
 */

import { BLOCK_GAP, Container, Markdown, type MarkdownTheme, SELECTION_BLOCK, Spacer } from '@/tui/index.js';
import { wrapOsc133Zones } from '@/tui/text/utils.js';
import { getMarkdownTheme, theme } from '@/plugins/sph-tui/theme/theme.js';

/** 正文左边距 3 列，和工具行的缩进对齐。 */
const DEFAULT_OUTPUT_PAD = 3;

/**
 * 流式正文重解析的最短间隔；真实间隔按上一帧实测耗时 ×3 自适应放大。
 *
 * 与思考正文（tool-group.ts 的 STREAM_BODY_MIN_MS）同一套做法、同一组实测数字：
 * 允许正文在流式期间滞后几帧，换帧率不被一条长回答拖死。收尾那帧不节流。
 */
const STREAM_REFRESH_MIN_MS = 120;

export class AssistantMessageComponent extends Container {
  readonly [SELECTION_BLOCK] = true;
  private readonly contentContainer: Container;
  private readonly markdownTheme: MarkdownTheme;
  private readonly outputPad: number;
  /** 正文 Markdown 跨帧复用：流式增量只 setText，避免每帧丢掉宽度缓存。 */
  private bodyMarkdown: Markdown | undefined;
  /** 上一次正文重解析的时刻与实测帧耗时：流式节流的依据，见 rebuild。 */
  private bodyRefreshedAt = 0;
  private bodyRefreshCost = 0;
  /** 本帧重解析过正文：render 末尾把实测耗时回喂给它。 */
  private measureBodyCost = false;
  /** 权威值待落盘（setText / 收尾）：这一帧跳过节流。 */
  private bodyForce = false;

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

  /** 整体替换正文（权威值）。权威值不节流：这一帧一定把全文落上屏。 */
  setText(text: string): void {
    this.text = text;
    this.bodyForce = true;
    this.markDirty();
  }

  appendText(delta: string): void {
    this.text += delta;
    this.markDirty();
  }

  setStreaming(streaming: boolean): void {
    this.isStreaming = streaming;
    // 流结束必须把权威全文落上屏：节流只允许"过程"滞后，不允许收尾滞后。
    // 这里同时标脏——正文只经 appendText 累加（收尾没有一次 setText 全文），
    // 若最后一帧恰好被节流跳过，不标脏就再没有 render 会来补上，尾巴会丢。
    if (!streaming) {
      this.bodyForce = true;
      this.markDirty();
    }
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
      // 流式期间节流正文重解析（见 STREAM_REFRESH_MIN_MS）：间隔取「上一帧实测耗时 ×3」，
      // 这一项的 CPU 占用因此有上界。权威 setText 与收尾（setStreaming(false)）都设了
      // bodyForce，不参与节流——最终内容一定落上屏。
      const due =
        Date.now() - this.bodyRefreshedAt >= Math.max(STREAM_REFRESH_MIN_MS, this.bodyRefreshCost * 3);
      if (this.bodyForce || !this.isStreaming || due) {
        this.bodyMarkdown.setText(body);
        this.bodyRefreshedAt = Date.now();
        this.measureBodyCost = true;
      }
    } else {
      this.bodyMarkdown = new Markdown(body, this.outputPad, 0, this.markdownTheme, {
        color: (content: string) => theme.fg('mdText', content),
      });
      this.bodyRefreshedAt = Date.now();
      this.measureBodyCost = true;
    }
    this.bodyForce = false;
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
    const startedAt = performance.now();
    const lines = wrapOsc133Zones(super.render(width));
    // 必须在渲染之后量：setText 只是作废缓存，真正的解析发生在这一趟渲染里。
    if (this.measureBodyCost) {
      this.measureBodyCost = false;
      this.bodyRefreshCost = performance.now() - startedAt;
    }
    return lines;
  }
}
