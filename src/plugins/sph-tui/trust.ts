/**
 * 启动前的工作区信任闸门。
 *
 * 信任发生在 sandbox / session / agent 创建之前，不能复用 InteractiveMode 的会话布局。
 * 画面对齐 grok-build 的 welcome trust：全屏居中（logo、提问、路径、风险说明、y/n）。
 * 替代屏幕由调用方 start 一次，本模块只换 layout，确认后主界面在同一块屏上接手。
 */

import {
  matchesKey,
  truncateToWidth,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  type ViewportTUI,
  visibleWidth,
  wrapTextWithAnsi,
} from './screen/index.js';
import { theme } from './theme/theme.js';
import { readVersion } from '../../version.js';

const QUESTION = 'Do you trust the contents of this directory?';
const WARN_1 = 'Spring Harness may run or modify contents in this directory,';
const WARN_2 = 'posing security risks.';

const MENU = [
  { key: 'y', label: 'Yes, proceed' },
  { key: 'n', label: 'No, quit' },
] as const;

/** 与 header 同一套字标，去掉左缘空格后给居中排版。 */
const LOGO_SMALL = ['▄▄▄▄  ▄▄▄▄  ▄▄  ▄▄', '██▄▄  ██▄█▄ ██▄▄██', '▀▀▀▀  ▀▀ ▀▀ ▀▀  ▀▀'];

/** 高终端上用更高的字标，体量接近 grok-build 的 stacked logo。 */
const LOGO_FULL = [
  '▄▄▄▄▄▄  ▄▄▄▄▄▄  ▄▄    ▄▄',
  '██      ██  ██  ██    ██',
  '██████  ██████  ████████',
  '    ██  ██      ██    ██',
  '██████  ██      ██    ██',
];

const MENU_MIN_WIDTH = 30;
const FULL_LOGO_MIN_HEIGHT = 22;
const SMALL_LOGO_MIN_HEIGHT = 16;

function pickLogo(height: number): string[] {
  if (height >= FULL_LOGO_MIN_HEIGHT) return LOGO_FULL;
  if (height >= SMALL_LOGO_MIN_HEIGHT) return LOGO_SMALL;
  return [];
}

function logoWidth(lines: string[]): number {
  return lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
}

function center(text: string, width: number): string {
  const w = visibleWidth(text);
  if (w >= width) return truncateToWidth(text, width, '');
  return `${' '.repeat(Math.floor((width - w) / 2))}${text}`;
}

function alignRight(text: string, width: number): string {
  const w = visibleWidth(text);
  if (w >= width) return truncateToWidth(text, width, '');
  return `${' '.repeat(width - w)}${text}`;
}

function centeredWrapped(text: string, color: (s: string) => string, inner: number, width: number): string[] {
  return wrapTextWithAnsi(text, Math.max(1, inner)).map((line) => center(color(line), width));
}

/**
 * grok-build welcome trust 的全屏画面：垂直按「上 1/3 留白 + 内容 + 弹性空白 + 版本」堆叠，
 * 菜单是左标签右快捷键；↑/↓ 选中，Enter 确认当前项，y 信任，n/Esc 退出。
 */
class TrustScreen implements Component {
  private hoverIndex = 0;
  private menuTop = 0;
  private menuLeft = 0;
  private menuWidth = 0;
  private decided = false;
  onDecide?: (trusted: boolean) => void;

  constructor(
    private readonly workspaceRoot: string,
    private readonly rows: () => number,
  ) {}

  invalidate(): void {
    // 每帧按终端尺寸重排，无缓存。
  }

  handleInput(data: string): void {
    if (this.decided) return;
    if (matchesKey(data, 'up')) {
      this.hoverIndex = Math.max(0, this.hoverIndex - 1);
      return;
    }
    if (matchesKey(data, 'down')) {
      this.hoverIndex = Math.min(MENU.length - 1, this.hoverIndex + 1);
      return;
    }
    if (matchesKey(data, 'y') || matchesKey(data, 'shift+y')) {
      this.finish(true);
      return;
    }
    if (
      matchesKey(data, 'n') ||
      matchesKey(data, 'shift+n') ||
      matchesKey(data, 'escape') ||
      matchesKey(data, 'ctrl+c') ||
      matchesKey(data, 'ctrl+d')
    ) {
      this.finish(false);
      return;
    }
    if (matchesKey(data, 'enter')) this.finish(this.hoverIndex === 0);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.decided) return undefined;
    const index = this.hitMenu(event.x, event.y);
    if (event.type === 'move') {
      if (index === undefined || index === this.hoverIndex) return undefined;
      this.hoverIndex = index;
      return { handled: true, render: true };
    }
    // 点选当前项；Enter / ↑↓ 走键盘路径。
    if (event.type === 'press' && event.button === 'left' && index !== undefined) {
      this.finish(index === 0);
      return { handled: true, render: true };
    }
    return undefined;
  }

  render(width: number): string[] {
    const height = Math.max(1, this.rows());
    const inner = Math.max(1, width - 4);
    const logo = pickLogo(height);
    const mark = logoWidth(logo);

    const message: string[] = [
      ...centeredWrapped(QUESTION, (s) => theme.fg('text', s), inner, width),
      ...centeredWrapped(this.workspaceRoot, (s) => theme.fg('primary', s), inner, width),
      '',
      ...centeredWrapped(WARN_1, (s) => theme.fg('muted', s), inner, width),
      ...centeredWrapped(WARN_2, (s) => theme.fg('muted', s), inner, width),
      '',
    ];

    const contentMin = MENU.reduce((max, item) => Math.max(max, visibleWidth(item.label) + 4 + visibleWidth(item.key)), 0);
    this.menuWidth = Math.min(width, Math.max(MENU_MIN_WIDTH, mark, contentMin));
    this.menuLeft = Math.max(0, Math.floor((width - this.menuWidth) / 2));

    const logoBlock = logo.length === 0 ? [] : [...logo.map((line) => center(theme.fg('muted', line), width)), ''];
    const bodyHeight = logoBlock.length + message.length + MENU.length;
    const versionRows = height > bodyHeight + 1 ? 2 : height > bodyHeight ? 1 : 0;
    const remaining = Math.max(0, height - bodyHeight - versionRows);
    const topPad = Math.floor(remaining / 3);

    const lines: string[] = Array.from({ length: height }, () => '');
    let y = topPad;
    const blit = (row: string): void => {
      if (y >= 0 && y < height - versionRows) lines[y] = row;
      y += 1;
    };
    for (const row of logoBlock) blit(row);
    for (const row of message) blit(row);
    this.menuTop = y;
    for (let i = 0; i < MENU.length; i++) blit(this.renderMenuRow(i, width));

    if (versionRows > 0) {
      const badge = `${theme.bold(theme.fg('text', 'Spring Harness  '))}${theme.fg('muted', readVersion())}`;
      lines[height - 1] = alignRight(badge, Math.max(1, width - 1));
    }
    return lines;
  }

  private renderMenuRow(index: number, width: number): string {
    const item = MENU[index]!;
    const selected = index === this.hoverIndex;
    const keyWidth = visibleWidth(item.key);
    const label = truncateToWidth(item.label, Math.max(1, this.menuWidth - keyWidth - 1), '');
    const gap = Math.max(1, this.menuWidth - visibleWidth(label) - keyWidth);
    const raw = `${label}${' '.repeat(gap)}${item.key}`;
    const row = selected
      ? theme.bold(theme.fg('primary', raw))
      : `${theme.bold(theme.fg('text', label))}${' '.repeat(gap)}${theme.fg('muted', item.key)}`;
    const left = ' '.repeat(this.menuLeft);
    const used = this.menuLeft + this.menuWidth;
    const right = used < width ? ' '.repeat(width - used) : '';
    return `${left}${row}${right}`;
  }

  private hitMenu(x: number, y: number): number | undefined {
    if (x < this.menuLeft || x >= this.menuLeft + this.menuWidth) return undefined;
    const index = y - this.menuTop;
    if (index < 0 || index >= MENU.length) return undefined;
    return index;
  }

  private finish(trusted: boolean): void {
    if (this.decided) return;
    this.decided = true;
    this.onDecide?.(trusted);
  }
}

/**
 * 在已经 start 的替代屏幕上画信任页，不自己进退屏。
 * 拒绝、Ctrl+C 与非 TTY 都返回 false，调用方统一 fail-closed。
 */
export function confirmWorkspaceTrust(workspaceRoot: string, ui: ViewportTUI): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve(false);

  const screen = new TrustScreen(workspaceRoot, () => ui.terminal.rows);
  return new Promise<boolean>((resolve) => {
    screen.onDecide = resolve;
    ui.setLayoutRoot(screen);
    ui.setFocus(screen);
    ui.requestRender();
  });
}
