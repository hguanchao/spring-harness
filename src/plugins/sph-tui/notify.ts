/**
 * 一次「做完了」要不要提醒、以及提醒该写哪些字节。
 *
 * 闸门与档位都收在这一个纯函数里：给它焦点状态、这段等待的耗时、配置阈值，它返回**要写进
 * 终端的那串字节**（空串就是不提醒）。这样「`off` 时一个字节都不写」「正盯着短问答不响」
 * 这类要求是能被单元测试钉住的，而不靠运行时肉眼听。
 *
 * 取值本身（`auto | bell | desktop | off`）定义在 config/primitives.ts：那是 config.toml 的
 * 词汇，配置解析层要能独立解析。
 */

import { BELL, desktopNotifySequence } from '@/tui/terminal/notifications.js';
import type { NotificationChannel } from '@/tui/terminal/terminal-image.js';
import type { NotifySetting } from '@/config/primitives.js';

/** `/notify` 菜单与配置模板的说明文案。 */
export const NOTIFY_HINTS: Record<NotifySetting, string> = {
  auto: 'Bell plus a desktop notification — only when the terminal is unfocused or the wait was long',
  bell: 'Terminal bell only, under the same focus gate',
  desktop: 'Desktop notification only, under the same focus gate',
  off: 'Never notify when work finishes',
};

export interface CompletionNotice {
  setting: NotifySetting;
  /** 这台终端接受的桌面通知 OSC；`none` 时 `auto` 只剩响铃。 */
  channel: NotificationChannel;
  /** 焦点在不在终端窗口里（DECSET 1004 上报）。 */
  focused: boolean;
  /** 这段等待已经过了多久。 */
  elapsedMs: number;
  /** 焦点在时至少要等多久才提醒；0 = 只要在跑完就提醒。 */
  afterMs: number;
  title: string;
  body: string;
}

/**
 * 默认不在你眼前响：`提醒 = 已开启 && ( 失焦 || 耗时 ≥ 阈值 )`。
 *
 * 盯着屏幕时转录里本来就有收尾痕迹，再响是噪音；切去干别的才是这一声要服务的情形。
 * 阈值填 0 就退化成「跑完就响」。
 *
 * `auto` = 响铃 + 桌面通知（探测不到通道时只剩响铃）；`bell` / `desktop` = 各走一条；
 * `off` = 空串，调用方连 write 都不该发生。
 */
export function notificationBytes(notice: CompletionNotice): string {
  if (notice.setting === 'off') return '';
  if (notice.focused && notice.elapsedMs < notice.afterMs) return '';
  const bell = notice.setting === 'auto' || notice.setting === 'bell' ? BELL : '';
  const desktop =
    notice.setting === 'auto' || notice.setting === 'desktop'
      ? desktopNotifySequence(notice.channel, notice.title, notice.body)
      : '';
  return `${bell}${desktop}`;
}

/** 耗时文案：`12.4s` / `2m 08s`。收尾通知的正文只用这一种格式，长短两种都能一眼读出。 */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return `${minutes}m ${String(rest).padStart(2, '0')}s`;
}
