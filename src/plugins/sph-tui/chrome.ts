/**
 * 产品叠在备用屏幕上的行为。
 *
 * 吸顶气泡认识具体消息块，控件层只留四个调用点。
 * 信任页和主界面共用这一份，避免两处各接一遍之后有一处漏掉画布色或吸顶。
 */

import type { TuiAltScreenOptions, ViewportChrome } from '../../tui/tui-alt-screen.js';
import { compositeStickyUserMessages, stickyOverlayRects } from './components/sticky-user-message.js';
import { oscResetCanvasBackground, oscSetCanvasBackground } from './theme/theme.js';

export const transcriptChrome: ViewportChrome = {
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

export function productScreenOptions(): Pick<TuiAltScreenOptions, 'canvas' | 'chrome'> {
  return {
    canvas: { set: oscSetCanvasBackground, reset: oscResetCanvasBackground },
    chrome: transcriptChrome,
  };
}
