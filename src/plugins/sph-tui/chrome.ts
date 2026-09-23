/**
 * 产品叠在备用屏幕上的行为。
 *
 * 行选中和吸顶气泡认识具体消息块，控件层只留四个调用点。
 * 信任页和主界面共用这一份，避免两处各接一遍之后有一处漏掉画布色或吸顶。
 */

import type { TuiAltScreenOptions, ViewportChrome } from '../../tui/tui-alt-screen.js';
import type { Component } from '../../tui/tui.js';
import { compositeRowSelection, isSelectableRow, selectRow } from './components/selectable-row.js';
import { compositeStickyUserMessages, stickyOverlayRects } from './components/sticky-user-message.js';
import { oscResetCanvasBackground, oscSetCanvasBackground } from './theme/theme.js';

export const transcriptChrome: ViewportChrome = {
  reset() {
    selectRow(undefined);
  },
  hitRects(frame) {
    return stickyOverlayRects(frame);
  },
  pressEmpty(components: readonly Component[]) {
    return selectRow(components.find(isSelectableRow));
  },
  composite(screen, frame, width) {
    return compositeStickyUserMessages(compositeRowSelection(screen, frame, width), frame, width);
  },
};

export function productScreenOptions(): Pick<TuiAltScreenOptions, 'canvas' | 'chrome'> {
  return {
    canvas: { set: oscSetCanvasBackground, reset: oscResetCanvasBackground },
    chrome: transcriptChrome,
  };
}
