import { type Component, Loader, type TUI, visibleWidth } from "../core/index.js";
import { appKeyText, type AppKeybinding } from "../app-keybindings.js";
import { theme } from "../theme/theme.js";
import { flattenWhitespace } from "../../util.js";

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
 * statusContainer）：转圈 + 活动 + 阶段耗时，右侧本轮耗时与 token；空闲与工作同为两行。
 */


export interface WorkingIndicatorOptions {
  frames?: string[];
  intervalMs?: number;
}

export type StatusIndicatorKind = 'working' | 'retry' | 'compaction';

/**
 * 状态行文案：一个工作轮次里不同阶段给不同措辞。
 *
 * 布局是转圈 + 活动 + 阶段耗时，右侧本轮耗时与 `↓token`。文案是唯一真源，
 * 调用方只按阶段取词，不各自拼字符串。
 */
export const WorkingLabel = {
  /** 请求已发出、还没有思考/正文/工具这些更具体的流。 */
  working: 'Calling model…',
  thinking: 'Thinking…',
  responding: 'Replying…',
  cancelling: 'Stopping…',
  /** LLM 摘要压缩正在跑；loop 用同一句 status 通知 TUI，不要改成 notice。 */
  compacting: 'Folding context…',
  /**
   * 工具执行中。name 是界面短名（Bash / Read / Grep），subject 是路径或命令摘要。
   * 有 subject 时不写 Running：状态行要的是正在干什么，不是「正在跑某个工具类」。
   */
  running: (name: string, subject?: string): string => {
    const detail = subject === undefined ? '' : flattenWhitespace(subject);
    if (detail === '') return `${name}…`;
    return `${name} ${clampActivitySubject(detail)}…`;
  },
} as const;

/** 状态行工具摘要上限：超过就靠行宽再裁，这里先截掉命令墙。 */
const ACTIVITY_SUBJECT_MAX = 40;

function clampActivitySubject(text: string): string {
  const chars = [...text];
  return chars.length <= ACTIVITY_SUBJECT_MAX ? text : chars.slice(0, ACTIVITY_SUBJECT_MAX).join('');
}

const RETRY_STREAM_RE = /^Retrying LLM stream \(attempt (\d+)\):\s*(.*)$/;

/** 同一条警告用来累计次数；重试按分类后的 headline 归并，attempt 不进 key。 */
export function workingWarningKey(text: string): string {
  const retry = RETRY_STREAM_RE.exec(text);
  if (retry) return classifyRetryHeadline(retry[2] ?? '') ?? 'retry';
  return classifyWorkingWarning(text);
}

/**
 * 工作状态行上的警告。
 *
 * 传输重试写成 `{headline} · retry N`（N 取报文里的 attempt，不靠累计）。
 * 其它警告分类后只在重复时加 `(N)`，避免首次就挂一个 `(1)`。
 */
export function formatWorkingWarning(text: string, count: number): string {
  const retry = RETRY_STREAM_RE.exec(text);
  if (retry) {
    const attempt = retry[1];
    const headline = classifyRetryHeadline(retry[2] ?? '');
    return headline ? `${headline} · retry ${attempt}` : `retry ${attempt}`;
  }
  const headline = classifyWorkingWarning(text);
  return count > 1 ? `${headline} (${count})` : headline;
}

function classifyRetryHeadline(raw: string): string | undefined {
  const text = raw.trim();
  if (/dropping extra request fields/i.test(text)) return 'Dropping extra fields';
  const status = parseWarningStatus(text);
  if (status !== undefined) {
    if (status === 408 || status === 504) return `Timed out (${status})`;
    if (status === 429) return `Rate-limited (${status})`;
    if (status === 401 || status === 403) return `Auth failed (${status})`;
    if (status === 404) return `Not found (${status})`;
    if (status === 413) return `Too large (${status})`;
    if (status >= 500) return `Upstream ${status}`;
    if (status >= 400) return `Rejected (${status})`;
  }
  const lower = text.toLowerCase();
  if (lower.includes('idle timeout')) return 'Stream stalled';
  if (
    lower.includes('no content')
    || lower.includes('empty')
    || lower.includes('missing body')
    || lower.includes('no sse')
  ) {
    return 'Empty reply';
  }
  if (
    lower.includes('network error')
    || lower.includes('fetch failed')
    || lower.includes('socket hang up')
    || lower.includes('econnreset')
    || lower.includes('und_err')
  ) {
    return 'Network error';
  }
  if (lower.includes('html instead of sse')) return 'Non-SSE reply';
  return undefined;
}

function classifyWorkingWarning(text: string): string {
  if (/without a finish reason/i.test(text)) return 'No finish reason';
  if (/truncated \(hit max_tokens\)/i.test(text)) return 'Hit max_tokens';
  const budget = /Session token budget (\d+)%/i.exec(text);
  if (budget) return `Token budget ${budget[1]}%`;
  return flattenWhitespace(text) || text;
}

function parseWarningStatus(raw: string): number | undefined {
  const llm = /LLM HTTP (\d{3})/.exec(raw);
  if (llm) return Number(llm[1]);
  const status = /status (\d{3})/i.exec(raw);
  if (status) return Number(status[1]);
  return undefined;
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
    this.setTimerColor((text) => theme.fg('muted', text));
  }
}

/**
 * 空闲占位：固定两行空白，避免状态区高度抖动。
 * 第二行右上角可临时挂一条提示（复制反馈）——空闲时没有 Loader，反馈落在占位行上。
 */
export class IdleStatus implements Component {
  private hint?: string;
  private hintTimer?: NodeJS.Timeout;

  constructor(private readonly requestRender: () => void) {}

  showHint(text: string, durationMs = 1200): void {
    this.clearHintTimer();
    this.hint = text;
    this.requestRender();
    this.hintTimer = setTimeout(() => {
      this.hintTimer = undefined;
      this.hint = undefined;
      this.requestRender();
    }, Math.max(0, durationMs));
    this.hintTimer.unref();
  }

  private clearHintTimer(): void {
    if (this.hintTimer) {
      clearTimeout(this.hintTimer);
      this.hintTimer = undefined;
    }
  }

  /** 立即撤掉提示并恢复空白占位。 */
  clearHint(): void {
    this.clearHintTimer();
    if (this.hint === undefined) return;
    this.hint = undefined;
    this.requestRender();
  }

  invalidate(): void {
    // 无缓存状态。
  }

  render(width: number): string[] {
    if (this.hint === undefined) {
      // 空行不要铺空格：铺满的空格在 Windows Terminal 上会显出浅底。
      return ['', ''];
    }
    const text = ` ${this.hint} `;
    const textW = visibleWidth(text);
    // 空闲行右侧留 4 列与工作态右缘对齐；窄到放不下就整体省略，不裁一半。
    if (textW + 4 > width) return ['', ''];
    const blank = '';
    const line = `\x1b[${width - 4 - textW + 1}G\x1b[7m${text}\x1b[27m`;
    return [blank, line];
  }
}
