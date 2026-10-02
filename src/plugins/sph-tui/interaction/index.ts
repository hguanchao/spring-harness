import { type Component, Loader, type TUI } from "@/tui/index.js";
import { appKeyText, type AppKeybinding } from "@/plugins/sph-tui/input/app-keybindings.js";
import { theme } from "@/plugins/sph-tui/theme/theme.js";
import { flattenWhitespace } from "@/util.js";

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
 * 键位提示：把动作渲染成「键位 + 说明」的暗色提示。
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
 * working / retry / compaction 三类状态，
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
  /** 工具已发出 tool_start 但卡在审批弹窗上,还没有真正执行。 */
  awaitingApproval: 'Waiting for approval…',
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
  // 只认完整词组：裸 `empty` 会把 shell 结果里的 `stdout: (empty)` 误判成传输故障。
  if (
    lower.includes('no content')
    || /empty (?:reply|response|body|message|payload|sse)/.test(lower)
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

/**
 * 失败行标题用的短句。认得出的传输/鉴权/限流换成一句话，认不出就截短。
 * 原文仍由调用方放在展开详情里。
 */
export function failureHeadline(raw: string): string {
  const text = flattenWhitespace(raw);
  if (text === '') return 'Failed';
  if (/does not match the HTTP\/1\.1 protocol|invalid eof/i.test(text)) return 'Upstream disconnected';
  // shell 失败结果是 `exit N` + stdout/stderr 全文（timeout 说明可能在最前）：标题只留退出码，
  // 全文展开可见；否则会被当成长文本截断，或者被 `stdout: (empty)` 带进传输分类。
  const shellExit = /(?:^| )exit (\d+|timeout)(?: (?:stdout|stderr)\b|$)/.exec(text);
  if (shellExit) return `exit ${shellExit[1]}`;
  const retry = classifyRetryHeadline(text);
  if (retry) return retry;
  if (/network error|fetch failed|socket hang up|econnreset|und_err/i.test(text)) return 'Network error';
  if (text.length <= 72) return text;
  return `${[...text].slice(0, 71).join('')}…`;
}

function classifyWorkingWarning(text: string): string {
  if (/does not match the HTTP\/1\.1 protocol|invalid eof/i.test(text)) return 'Upstream disconnected';
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

class StatusIndicator extends Loader {
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
    this.shimmer = (text, now) => theme.shimmer(text, now);
    this.setShimmer(true);
  }
}

/** 空闲占位：固定两行空白，避免状态区高度抖动——工作态（转圈 + 文案）也是两行。 */
export class IdleStatus implements Component {
  invalidate(): void {
    // 无缓存状态。
  }

  render(): string[] {
    return ['', ''];
  }
}
