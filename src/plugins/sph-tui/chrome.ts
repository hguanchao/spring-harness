/**
 * 备用屏幕的产品外观——只有画布底色这一项。
 *
 * 这里必须保持「轻」：信任页在 bootstrap 之前跑，用的就是这份选项，静态引进来任何消息块，
 * 都会让一屏 logo + y/n 连带加载它们。主界面专属的叠层（用户消息吸顶）在
 * transcript-chrome.ts，由它把这里的画布色组合进完整的一套。
 */

import type { TuiAltScreenOptions } from '@/tui/screen/tui-alt-screen.js';
import { oscResetCanvasBackground, oscSetCanvasBackground } from '@/plugins/sph-tui/theme/theme.js';

/** 信任页与主界面共用的画布色：一处定义，两边都从这里取，不会各接一遍后漏掉。 */
export const canvasOptions: Pick<TuiAltScreenOptions, 'canvas'> = {
  canvas: { set: oscSetCanvasBackground, reset: oscResetCanvasBackground },
};
