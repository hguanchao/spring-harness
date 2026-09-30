/**
 * 完成提醒用的终端序列：响铃与桌面通知。
 *
 * 这些只是一串字节，写出去的是 `terminal.write()`，而不是 Terminal 接口上的新方法：
 * 「这台终端认哪一种 OSC」只有宿主（探测得到能力）知道，控件层负责把该不该响、响哪一档
 * 决定清楚，把最终序列原样交给输出流。走 write() 也让测试能在假终端上直接断言写出了 `\a`。
 *
 * 正文一律先清洗再拼装：通知文案里可能带着错误信息或用户粘贴的文本，残留的 ESC / BEL
 * 会把后面的内容当成转义序列执行。
 */

import type { NotificationChannel } from '@/tui/terminal/terminal-image.js';

export const BELL = '\x07';

/** 桌面通知的固定标题：让这一条一眼归属 sph，正文才放得下真正信息。 */
export const NOTIFY_TITLE = 'sph';

/** 去掉控制字符并把换行压成空格——通知正文是一行。 */
export function sanitizeNotificationText(text: string): string {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim();
}

function st(): string {
  return '\x1b\\';
}

/**
 * 各终端家族的桌面通知格式。
 *
 * - OSC 9：iTerm2 / Windows Terminal / WezTerm / Ghostty 等，只有正文，无标题字段。
 * - OSC 777：rxvt-unicode 系，`notify;<title>;<body>`。
 * - OSC 99：分三段（0=标题、1=正文、2=结束），带一个通知 id 便于覆盖上一条。
 * - none：返回空串，调用方不写任何字节。
 */
export function desktopNotifySequence(channel: NotificationChannel, title: string, body: string): string {
  const summary = sanitizeNotificationText(title);
  const detail = sanitizeNotificationText(body);
  switch (channel) {
    case 'osc9':
      return `\x1b]9;${summary ? `${summary}: ${detail}` : detail}\x07`;
    case 'osc777':
      return `\x1b]777;notify;${summary};${detail}${st()}`;
    case 'osc99':
      return `\x1b]99;i=sph:d=0;${summary}${st()}\x1b]99;i=sph:d=1;${detail}${st()}\x1b]99;i=sph:d=2;${st()}`;
    case 'none':
      return '';
  }
}
