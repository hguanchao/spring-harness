/**
 * 挂起条：运行中输入队列（steering inbox）的可视化与行内鼠标交互。
 *
 * 每帧从 turnInbox 动态取数——消息只在轮次收尾后逐条投递，投递一条下一帧自动少一条。
 * 队列空即零占用。渲染、按钮命中与行操作都在这里；「立即发送」的中断语义属于宿主
 * （交互模式），经 sendNow 回调落地，两边职责不混。
 */

import type { SteeringInbox } from '../sph-schedule/jobs.js';
import { flattenWhitespace } from '../../util.js';
import { visibleWidth } from '../../tui/utils.js';
import type { Component, TuiMouseEvent, TuiMouseEventResult } from '../../tui/index.js';
import { handleSelectablePress } from './components/selectable-row.js';
import { theme } from './theme/theme.js';
import type { CustomEditor } from './components/custom-editor.js';

/** 挂起条行右缘预留（4 列 = 1 列滚动条 + 空两格，与状态行 Loader 同款，右缘同列）。 */
const STEER_RIGHT_PAD = 4;
/** 挂起条首行上方的空行间距；鼠标 y 换算行下标时要扣掉它。 */
const STEER_TOP_GAP = 1;
/**
 * 挂起条动作按钮链（从右往左紧贴无缝，宽不够整颗放弃）。纯鼠标操作，无键盘快捷键，
 * 避免与 TUI 既有按键冲突；[↑]/[↓] 只在该行可移动时渲染。
 */
const STEER_BUTTONS: Array<{ action: SteerAction; label: string }> = [
  { action: 'cancel', label: '[cancel]' },
  { action: 'edit', label: '[edit]' },
  { action: 'send', label: '[Send now]' },
  { action: 'down', label: '[↓]' },
  { action: 'up', label: '[↑]' },
];

type SteerAction = 'cancel' | 'edit' | 'send' | 'down' | 'up';

/** 挂起条需要的宿主能力：渲染、输入框草稿、与轮次中断的收口。 */
export interface SteerBarHost {
  requestRender(): void;
  invalidateContent(): void;
  /** 取回编辑后把焦点交回输入框。 */
  focusEditor(): void;
  /** 输入框草稿：[edit] 把消息取回到这里。 */
  editor: Pick<CustomEditor, 'getText' | 'setText'>;
  /** 当前是否存在可中断的轮次（[Send now] 的前置检查）。 */
  canInterrupt(): boolean;
  /** 立即发送的落地：宿主把该文本记为中断后的下一轮 prompt 并中断当前轮。 */
  sendNow(text: string): void;
}

export class SteerBar {
  /** 挂起队列的选中项下标：单击行的加粗标识。 */
  private cursor?: number;
  /** 鼠标悬停的挂起消息下标：该行铺极浅底并亮出动作按钮，移出即隐藏。 */
  private hover?: number;
  /** 悬停中的动作按钮：按钮文字按动作变色（cancel 红、edit/send 亮）。 */
  private buttonHover?: { row: number; action: SteerAction };
  /** 本帧渲染出的按钮命中区（组件局部坐标，x 为半开区间 [x0, x1)，y = row + STEER_TOP_GAP）。 */
  private buttons: Array<{ row: number; action: SteerAction; x0: number; x1: number }> = [];
  /**
   * 双击编辑占位：既是取回消息的原排序位（提交后插回，而不是排到队尾），也是投递
   * 冻结标志——非空期间轮末自动发送与立即发送全部让路，其余挂起消息等编辑提交后
   * 按序消化。
   */
  private editIndex?: number;
  private readonly bar: Component;

  constructor(
    private readonly inbox: SteeringInbox,
    private readonly host: SteerBarHost,
  ) {
    this.bar = {
      invalidate: () => {},
      render: (width: number) => this.render(width),
      handleMouse: (event) => this.onMouse(event),
    };
  }

  /** 挂进 dock 容器的组件本体（队列空时零占用，不影响布局）。 */
  get component(): Component {
    return this.bar;
  }

  /** 双击编辑占位非空 = 投递冻结中：轮末自动发送与立即发送全部让路。 */
  get editFrozen(): boolean {
    return this.editIndex !== undefined;
  }

  /** 队首挂起消息（轮次收尾后逐条投递的下一条）。 */
  get nextQueued(): string | undefined {
    return this.inbox.peek()[0];
  }

  /** 当前挂起条数（轮次失败提示里报数用）。 */
  get queuedCount(): number {
    return this.inbox.peek().length;
  }

  /** 运行中提交的新消息入队（队尾追加，选中标识指向它）。 */
  push(text: string): void {
    this.inbox.push(text);
    this.cursor = this.inbox.peek().length - 1;
  }

  /**
   * 编辑取回后的重新挂起：插回原排序位而不是队尾（队列已被 drain 时越界收敛为追加）。
   * 提交即解冻。返回队首消息——宿主若发现轮次已收尾，可拿它立即开新轮。
   */
  insertEdit(text: string): string | undefined {
    if (this.editIndex === undefined) return this.inbox.peek()[0];
    this.inbox.insertAt(this.editIndex, text);
    this.cursor = Math.min(this.editIndex, this.inbox.peek().length - 1);
    this.editIndex = undefined;
    return this.inbox.peek()[0];
  }

  /** 取走队首消息（轮次收尾后的逐条投递）。 */
  dropFirst(): string | undefined {
    return this.inbox.removeAt(0);
  }

  /** 整队搬走（立即发送 / 轮次作废回填）。 */
  drainAll(): string[] {
    return this.inbox.drain();
  }

  /** 队列被整队搬走（立即发送 / 轮次作废）后，选中、编辑占位一并失效。 */
  resetState(): void {
    this.cursor = undefined;
    this.editIndex = undefined;
    this.hover = undefined;
    this.buttonHover = undefined;
  }

  /**
   * 鼠标移动的悬停清理：任何移动先清挂起条高亮（行浅底/按钮变色）。
   * 返回是否有变化——调用方据此决定要不要 requestRender；若光标仍悬在原目标上，
   * 同帧的组件分发会重新点亮（监听器先于分发执行，一清一亮）。
   */
  clearHover(): boolean {
    if (this.hover === undefined && this.buttonHover === undefined) return false;
    this.hover = undefined;
    this.buttonHover = undefined;
    return true;
  }

  /**
   * 挂起条：运行中输入队列的可视化。纯鼠标操作，无键盘快捷键（避免与 TUI 按键冲突）。
   *
   * 首行上方留一行间距（与状态行脱开）；一格缩进与状态行左缘（leftPad=1）对齐。前缀是
   * 中性灰 `#` 加投递顺序序号（`#1.` `#2.`…，重排后按新位置重新编号）。鼠标悬停的行：整行铺极浅底
   * （steerHoverBg），右侧亮出动作按钮 `[↑] [↓] [Send now] [edit] [cancel]`（右对齐
   * 紧贴无缝、右缘与状态行耗时/token 同列，宽不够整颗放弃，行不可移动时 ↑/↓ 不渲染，
   * 按钮自身悬停变色）。
   */
  private render(width: number): string[] {
    const items = this.inbox.peek();
    if (items.length === 0) {
      this.buttons = [];
      return [];
    }
    const cursor = Math.min(this.cursor ?? items.length - 1, items.length - 1);
    const hover = this.hover !== undefined && this.hover < items.length ? this.hover : undefined;
    // 动作按钮只挂悬停行（单光标同一时刻至多悬停一行）。
    const buttons = hover === undefined ? [] : this.layoutButtons(width, hover, items.length);
    const btnStart = buttons[0]?.x0 ?? width - STEER_RIGHT_PAD;
    this.buttons = buttons.map((button, i) => {
      const x0 = btnStart + buttons.slice(0, i).reduce((sum, b) => sum + b.label.length, 0);
      return { row: hover!, action: button.action, x0, x1: x0 + button.label.length };
    });
    const lines = items.map((text, index) => {
      const num = theme.fg('muted', '#') + theme.fg('primary', `${index + 1}.`);
      // 带按钮的行：行文按按钮起点截断让位（至少留 1 列间隙）。
      const avail = index === hover ? Math.max(0, btnStart - 4 - 1) : 96;
      const clipped = flattenWhitespace(text).slice(0, avail);
      const styled = index === cursor ? theme.bold(clipped) : theme.fg('muted', clipped);
      let line = ` ${num} ${styled}`;
      if (index === hover) {
        const pad = Math.max(1, btnStart - visibleWidth(line));
        line += ' '.repeat(pad);
        for (const button of buttons) line += this.buttonLabel(button.action, index);
      }
      // 悬停行整行铺极浅底。
      const fill = Math.max(0, width - visibleWidth(line));
      return index === hover ? theme.bg('steerHoverBg', line + ' '.repeat(fill)) : line;
    });
    lines.unshift('');
    return lines;
  }

  /**
   * 布局动作按钮链：从右往左紧贴排布，放不下整颗放弃；[↑]/[↓] 只在该行可移动时出现。
   * 空数组 = 宽度不足以放任何按钮。
   */
  private layoutButtons(width: number, row: number, count: number): Array<{ action: SteerAction; label: string; x0: number }> {
    let right = width - STEER_RIGHT_PAD;
    const placed: Array<{ action: SteerAction; label: string; x0: number }> = [];
    for (const { action, label } of STEER_BUTTONS) {
      if (action === 'up' && row === 0) continue;
      if (action === 'down' && row === count - 1) continue;
      const x0 = right - label.length;
      if (x0 < 5) break; // 行文至少保留一格缩进 + 序号 + 一格空隙
      placed.unshift({ action, label, x0 });
      right = x0;
    }
    return placed;
  }

  /** 动作按钮文案：默认 muted，悬停变色（cancel 红、其余亮文字）。 */
  private buttonLabel(action: SteerAction, row: number): string {
    const label = STEER_BUTTONS.find((button) => button.action === action)!.label;
    const hoveredButton = this.buttonHover?.row === row && this.buttonHover.action === action;
    if (!hoveredButton) return theme.fg('muted', label);
    return theme.fg(action === 'cancel' ? 'error' : 'text', label);
  }

  /**
   * 挂起条行内鼠标交互：按钮命中优先（[↑]/[↓]/[Send now]/[edit]/[cancel] 直接执行
   * 动作）；单击行 = 选中（加粗标识）。双击无特殊语义。左键按下先用
   * handleSelectablePress 钉行吃掉（与工具行同款）：否则全屏划词路径接手，
   * 会把消息文本选中。click 事件必须返回 handled 挡住冒泡，避免同一次点击沿布局链
   * 多次送达。
   */
  private onMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const items = this.inbox.peek();
    const row = event.y - STEER_TOP_GAP;
    const onRow = row >= 0 && row < items.length;
    if (event.type === 'move') {
      // 悬停：该行铺浅底并亮出动作按钮。移出的隐藏由 onMouseMotion 先清、这里的命中
      // 分发再点亮（同帧内一清一亮，不需要绝对坐标）。悬停不劫持键盘选中（cursor
      // 只由单击/键盘改，悬停只负责亮按钮）。首行是上间距空行：y 换算
      // 行下标要扣掉。
      if (onRow) {
        const button = this.buttons.find((b) => b.row === row && event.x >= b.x0 && event.x < b.x1);
        const nextButton = button ? { row, action: button.action } : undefined;
        if (
          this.hover !== row ||
          this.buttonHover?.row !== nextButton?.row ||
          this.buttonHover?.action !== nextButton?.action
        ) {
          this.hover = row;
          this.buttonHover = nextButton;
          this.host.requestRender();
        }
      }
      return undefined;
    }
    if (event.type === 'press' && event.button === 'left') {
      // 钉行只发生在有效行上：按在上间距空行不选中、不画行选标记。
      if (!onRow) return undefined;
      const press = handleSelectablePress(this.bar, event);
      if (press) return press;
    }
    if (event.type !== 'click' || event.button !== 'left') return undefined;
    if (!onRow) return undefined;
    // 按钮命中优先：直接执行动作，不再走行选中。
    const button = this.buttons.find((b) => b.row === row && event.x >= b.x0 && event.x < b.x1);
    if (button) {
      if (button.action === 'cancel') this.cancelRow(row);
      else if (button.action === 'edit') this.editRow(row);
      else if (button.action === 'send') this.sendRowNow(row);
      else if (button.action === 'up') this.moveRow(row, -1);
      else this.moveRow(row, 1);
      return { handled: true };
    }
    // 单击行 = 选中（加粗标识）。
    this.cursor = row;
    this.host.invalidateContent();
    return { handled: true };
  }

  /** [↑]/[↓]：把该行与相邻行交换（序号随新位置重编）。队列结构变化使冻结原位失效。 */
  private moveRow(index: number, delta: -1 | 1): void {
    if (!this.inbox.move(index, delta)) return;
    this.editIndex = undefined;
    this.cursor = index + delta;
    this.host.invalidateContent();
  }

  /** 取回选中条到输入框编辑：队列里删掉、记住原位置并冻结投递（提交后原位回插）。 */
  private editRow(index: number): void {
    const text = this.inbox.removeAt(index);
    if (text === undefined) return;
    this.editIndex = index;
    const current = this.host.editor.getText().trim();
    this.host.editor.setText(current === '' ? text : `${current}\n\n${text}`);
    this.cursor = Math.min(index, this.inbox.peek().length - 1);
    this.host.focusEditor();
    this.host.invalidateContent();
  }

  /** 删除选中条（不回填编辑器）。队列结构变化：冻结编辑的原位置失效。 */
  private cancelRow(index: number): void {
    if (this.inbox.removeAt(index) === undefined) return;
    // 队列结构变化：冻结编辑的原位置失效（同 ⇧J/⇧K 的处理）。
    this.editIndex = undefined;
    this.cursor = Math.min(index, this.inbox.peek().length - 1);
    this.host.invalidateContent();
  }

  /** 强制立即发送选中条：中断当前轮，该条作为下一轮 prompt，其余消息保持原队列。 */
  private sendRowNow(index: number): void {
    // 先确认有可中断的轮次再动队列：反序会在轮次恰好收尾时把消息删成凭空消失。
    if (!this.host.canInterrupt()) return;
    const text = this.inbox.removeAt(index);
    if (text === undefined) return;
    this.host.sendNow(text);
  }
}
