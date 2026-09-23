/**
 * 子代理行：输入框上方 dock 里的实时进度行。
 *
 * 左侧：braille 转圈（含 ⠏）+ `Subagent N Explore 描述 · Thinking…`
 * 右侧：token 用量与已运行时长，窄终端时先截左侧。
 *
 * 转录里的工具行不共用这一套：那里只留 `Subagent N 描述 总耗时`。
 */

import { Container, isViewportTUI, Text, truncateToWidth, visibleWidth, type TUI } from '../../../tui/index.js';
import { theme } from '../theme/theme.js';
import { formatDuration } from '../../../util.js';

const DOCK_ROW_INDENT = 5;
/** 右缘预留：1 列滚动条 █ + 空两格——stats 贴到行宽末列会被滚动条盖住（与 Loader 同款约定）。 */
const DOCK_RIGHT_PAD = 4;
const STATS_GAP = 2;
/** 与状态行 Loader 同一套 braille 帧；用户指定运行中用 ⠏，转起来才像在跑。 */
const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPIN_MS = 80;

export function childTypeLabel(childType: string | undefined): string {
  return childType ? childType.charAt(0).toUpperCase() + childType.slice(1) : '';
}

export interface SubagentHeadParts {
  index: number;
  childType?: string;
  description: string;
  background?: boolean;
}

/** dock 行首：带类型，方便区分 explore / general。 */
export function subagentHeadText(parts: SubagentHeadParts): string {
  const type = childTypeLabel(parts.childType);
  const suffix = parts.background ? ' · background' : '';
  return `Subagent ${parts.index}${type ? ` ${type}` : ''} ${parts.description}${suffix}`;
}

/** 转录工具行：只要序号、描述，耗时另接。 */
export function subagentTranscriptText(parts: SubagentHeadParts): string {
  return `Subagent ${parts.index} ${parts.description}`;
}

function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '';
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}K` : `${Math.round(tokens)}`;
}

export class SubagentTaskComponent extends Container {
  private readonly ui: TUI;
  private readonly text = new Text('', 0, 0);
  private readonly head: string;
  private readonly startedAt = Date.now();
  private activity = '';
  private activityError = false;
  private tokens = 0;
  private dirty = true;
  private lastWidth = -1;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(ui: TUI, head: SubagentHeadParts) {
    super();
    this.ui = ui;
    this.head = subagentHeadText(head);
    this.addChild(this.text);
    this.timer = setInterval(() => {
      this.markDirty();
      this.paintDock();
    }, SPIN_MS);
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  setActivity(text: string, error = false): void {
    if (this.activity === text && this.activityError === error) return;
    this.activity = text;
    this.activityError = error;
    this.markDirty();
    this.paintDock();
  }

  addTokens(delta: number): void {
    if (!Number.isFinite(delta) || delta <= 0) return;
    this.tokens += delta;
    this.markDirty();
    this.paintDock();
  }

  private paintDock(): void {
    if (isViewportTUI(this.ui)) this.ui.requestViewportRender();
    else this.ui.requestRender();
  }

  private markDirty(): void {
    this.dirty = true;
  }

  override invalidate(): void {
    this.markDirty();
  }

  private statsText(): string {
    const elapsed = formatDuration(Date.now() - this.startedAt);
    const tokens = formatTokens(this.tokens);
    return tokens === '' ? elapsed : `${tokens} · ${elapsed}`;
  }

  private rebuild(width: number): void {
    const indent = ' '.repeat(DOCK_ROW_INDENT);
    const stats = this.statsText();
    const statsStyled = theme.fg('muted', stats);
    const statsWidth = visibleWidth(stats);
    const meta =
      this.activity === '' ? '' : theme.fg(this.activityError ? 'error' : 'muted', ` · ${this.activity}`);
    const frame = SPIN_FRAMES[Math.floor(Date.now() / SPIN_MS) % SPIN_FRAMES.length]!;
    const left = `${theme.fg('primary', frame)} ${theme.bold(theme.shimmer(this.head, Date.now()))}${meta}`;
    const inner = Math.max(1, width - DOCK_ROW_INDENT - DOCK_RIGHT_PAD);
    const leftMax = Math.max(1, inner - statsWidth - STATS_GAP);
    const clipped = truncateToWidth(left, leftMax, '…');
    const pad = Math.max(STATS_GAP, inner - visibleWidth(clipped) - statsWidth);
    this.text.setText(`${indent}${clipped}${' '.repeat(pad)}${statsStyled}`);
  }

  override render(width: number): string[] {
    if (this.dirty || this.lastWidth !== width) {
      this.dirty = false;
      this.lastWidth = width;
      this.rebuild(width);
    }
    return super.render(width);
  }
}
