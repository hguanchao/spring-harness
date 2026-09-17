import { type Component, Loader, type TUI } from "../core/index.js";
import { appKeyText, type AppKeybinding } from "../app-keybindings.js";
import { theme } from "../theme/theme.js";

/**
 * 双击识别。
 *
 * 不能直接用框架给的 `event.clickCount`：那个计数来自文本选择路径，只有两次点击落在
 * 同一行的同一个词上才递增，点在块内右侧的空白背景上永远是 1。
 *
 * 这里改用组件自己的坐标系判断——时间窗口内、坐标邻近即算双击。代价是同一个 click
 * 事件必须只送到本组件一次，因此调用方要返回 `{ handled: true }` 阻止事件沿布局
 * box 链继续向上冒泡（否则一次点击会触发多次判定，双击会被自己抵消）。
 */
export class DoubleClickTracker {
  private lastAt = 0;
  private lastX = Number.NaN;
  private lastY = Number.NaN;

  constructor(
    private readonly intervalMs = 500,
    private readonly slopX = 2,
    private readonly slopY = 1,
  ) {}

  /** 记录本次点击位置，并返回它是否构成双击。 */
  accept(x: number, y: number): boolean {
    const now = Date.now();
    const isDouble =
      now - this.lastAt <= this.intervalMs &&
      Math.abs(x - this.lastX) <= this.slopX &&
      Math.abs(y - this.lastY) <= this.slopY;
    this.lastAt = now;
    this.lastX = x;
    this.lastY = y;
    return isDouble;
  }
}

/**
 * 随视口宽度伸缩的分隔线。
 *
 * 直接对应参考实现 pi 的同名组件：整行填满 "─"，颜色可由调用方注入（默认取 border 色）。
 */


export class DynamicBorder implements Component {
  private color: (str: string) => string;

  constructor(color: (str: string) => string = (str) => theme.fg('border', str)) {
    this.color = color;
  }

  invalidate(): void {
    // 无缓存状态。
  }

  render(width: number): string[] {
    return [this.color('─'.repeat(Math.max(1, width)))];
  }
}

/**
 * 键位提示文案工具。
 *
 * 对应参考实现的 components/keybinding-hints.ts：把动作渲染成「键位 + 说明」的暗色提示。
 */


export function keyText(action: AppKeybinding): string {
  return appKeyText(action);
}

export function keyHint(action: AppKeybinding, description: string): string {
  return theme.fg('dim', keyText(action)) + theme.fg('muted', ` ${description}`);
}

/**
 * 活动状态指示器（转圈 + 文案）。
 *
 * 对应参考实现的 components/status-indicator.ts：working / retry / compaction 三类状态，
 * 以及空闲时占位的两行空白。渲染位置是输入框上方的状态行（见 InteractiveMode 的
 * statusContainer），左对齐，空闲与工作两种形态同为两行，切换时布局不抖。
 */


export interface WorkingIndicatorOptions {
  frames?: string[];
  intervalMs?: number;
}

export type StatusIndicatorKind = 'working' | 'retry' | 'compaction';

/**
 * 状态行文案：一个工作轮次里不同阶段给不同措辞。左起转圈 + 阶段短语，最右侧
 * 本轮已运行时长（`12.3s` / `2m13s`），对齐 grok-build turn status 行的右侧耗时。
 *
 * 文案是唯一真源，调用方只按阶段取词，不各自拼字符串。
 */
export const WorkingLabel = {
  /** 轮次在跑但还没解析出更具体的活动（含压缩、等待下一步模型调用）。 */
  working: 'Working…',
  thinking: 'Thinking…',
  responding: 'Responding…',
  cancelling: 'Cancelling…',
  /** 工具执行中；name 传界面显示名（Bash / Read / Grep…），不是工具 ID。 */
  running: (name: string): string => `Running ${name}…`,
} as const;

/** `Retrying LLM stream (attempt 2): idle timeout` → 只留原因，次数由状态行统一加 `(N)`。 */
export function workingWarningKey(text: string): string {
  const match = /^Retrying LLM stream \(attempt \d+\):\s*(.*)$/.exec(text);
  const body = (match?.[1] ?? text).trim();
  return body || text;
}

/** 工作状态行上的警告：正文 + 本轮同一条警告出现次数。 */
export function formatWorkingWarning(text: string, count: number): string {
  return `${workingWarningKey(text)} (${count})`;
}

export class StatusIndicator extends Loader {
  readonly kind: StatusIndicatorKind;

  constructor(
    kind: StatusIndicatorKind,
    ui: TUI,
    spinnerColorFn: (str: string) => string,
    messageColorFn: (str: string) => string,
    message: string,
    indicator?: WorkingIndicatorOptions,
  ) {
    super(ui, spinnerColorFn, messageColorFn, message, indicator);
    this.kind = kind;
  }

  dispose(): void {
    this.stop();
  }
}

export class WorkingStatusIndicator extends StatusIndicator {
  constructor(ui: TUI, message: string, indicator?: WorkingIndicatorOptions, colorFn?: (text: string) => string) {
    super(
      'working',
      ui,
      colorFn ?? ((text) => theme.fg('primary', text)),
      colorFn ?? ((text) => theme.fg('muted', text)),
      message,
      indicator,
    );
  }
}

/** 空闲占位：固定两行空白，避免状态区高度抖动。 */
export class IdleStatus implements Component {
  invalidate(): void {
    // 无缓存状态。
  }

  render(_width: number): string[] {
    // 空行不要铺空格：铺满的空格在 Windows Terminal 上会显出浅底。
    return ['', ''];
  }
}
