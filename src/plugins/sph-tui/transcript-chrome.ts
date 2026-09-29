/**
 * 主界面专属的备用屏幕叠层：用户消息吸顶。
 *
 * 吸顶气泡认识具体消息块，控件层只留四个调用点。单独成文件是为了把它挡在信任页之外——
 * 信任页只要画布色（见 chrome.ts），不该为一个 y/n 提示加载消息块与吸顶合成。
 */

import type { TuiAltScreenOptions, ViewportChrome } from '@/tui/screen/tui-alt-screen.js';
import { canvasOptions } from '@/plugins/sph-tui/chrome.js';
import { compositeStickyUserMessages, stickyOverlayRects } from '@/plugins/sph-tui/messages/sticky-user-message.js';

const transcriptChrome: ViewportChrome = {
  reset() {},
  hitRects(frame) {
    return stickyOverlayRects(frame);
  },
  // 行选中标记(行首 ❙)已移除:点击只保留按压接管语义,不再有需要重绘的选中状态。
  pressEmpty() {
    return false;
  },
  composite(screen, frame, width) {
    return compositeStickyUserMessages(screen, frame, width);
  },
};

/** 主界面完整的屏幕选项：共用的画布色 + 叠层。 */
export function productScreenOptions(): Pick<TuiAltScreenOptions, 'canvas' | 'chrome'> {
  return {
    ...canvasOptions,
    chrome: transcriptChrome,
  };
}
