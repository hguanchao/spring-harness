/**
 * Recap 块：会话「我讲到哪了」的一行摘要。
 *
 * 视觉对齐 grok-build：走工具行的观感（状态圆点 + 加粗 `Recap` 标签 + 弱化正文），
 * 与普通通知行区分开——recap 是会话级别的产物，不是又一条提示。正文按宽度折行并
 * 悬挂缩进，续行对齐到正文列（TOOL_MEMBER_INDENT）。
 *
 * 手动 `/recap` 先生成 pending 态（空心圆点 + `summarizing…`），拿到结果后**原地**换成
 * 正文：用户始终在同一行上看到进度，不会凭空多出一块、也不会留下占位的空行。
 * 自动 recap 不经过 pending 态，直接以正文出现。
 *
 * 块自带 BLOCK_GAP 前导空行（与 AssistantMessageComponent 同款）：空块渲染 0 行不占位，
 * 所以 pending 被撤掉时不会留下一道空行。
 */

import { BLOCK_GAP, type Component, type TuiMouseEvent, type TuiMouseEventResult, wrapTextWithAnsi } from '../../../tui/index.js';
import { theme } from '../theme/theme.js';
import { TOOL_GROUP_INDENT, TOOL_MEMBER_INDENT } from './tool-execution.js';

/** pending 态占位文案；对齐底部状态行的措辞。 */
const PENDING_BODY = 'summarizing…';

/** Recap 专用前缀：菱形（完成实心 / pending 空心），与工具行的圆点区分开。 */
const RECAP_MARK = { done: '◆', pending: '◇' } as const;

export class RecapMessageComponent implements Component {
  private summary: string;
  private pending: boolean;

  constructor(summary = '', pending = false) {
    this.summary = summary;
    this.pending = pending;
  }

  /** 生成完成：原地把 pending 换成正文。 */
  setSummary(summary: string): void {
    this.summary = summary;
    this.pending = false;
  }

  get isPending(): boolean {
    return this.pending;
  }

  invalidate(): void {
    // 无缓存状态。
  }

  /**
   * Recap 是只读摘要：正文行吞掉左键按压/点击，全屏划词不再在它身上起锚——
   * 双击它不会亮起选词高亮，也不能从它拖选（前导空行 y < BLOCK_GAP 放行，不挡块间距处的拖选）。
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.button !== 'left') return undefined;
    if (event.type !== 'press' && event.type !== 'click') return undefined;
    if (event.y < BLOCK_GAP) return undefined;
    return { handled: true };
  }

  render(width: number): string[] {
    const body = this.pending ? PENDING_BODY : this.summary;
    if (body === '') return [];

    // 前缀 `  ◆ ` 的可见宽度恰好是 TOOL_MEMBER_INDENT，续行直接按它悬挂。
    const mark = this.pending ? RECAP_MARK.pending : RECAP_MARK.done;
    const head = `${theme.bold(theme.fg('text', 'Recap'))}${theme.fg('dim', ' — ')}`;
    const painted = this.pending
      ? theme.bold(theme.fg('dim', body))
      : theme.bold(theme.fg('muted', body));

    const available = Math.max(1, width - TOOL_MEMBER_INDENT);
    const wrapped = wrapTextWithAnsi(`${head}${painted}`, available);
    const first = `${' '.repeat(TOOL_GROUP_INDENT)}${theme.fg(this.pending ? 'dim' : 'primary', mark)} `;
    const hang = ' '.repeat(TOOL_MEMBER_INDENT);

    const lines = wrapped.map((line, index) => (index === 0 ? `${first}${line}` : `${hang}${line}`));
    return [...Array.from({ length: BLOCK_GAP }, () => ''), ...lines];
  }
}
