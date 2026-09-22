/**
 * TUI 进程入口。
 *
 * 外面只拿到启动交互和信任确认。屏幕控件留在 screen/，不从这里再导出一套通用库。
 * createScreen 是例外：信任页要先占住备用屏幕，主界面接手同一块，所以创建权在调用方。
 */

import { ProcessTerminal, TuiAltScreen, type ViewportTUI } from './screen/index.js';

export { runTui, type TuiDeps } from './interactive-mode.js';
export { confirmWorkspaceTrust } from './trust.js';

/** 信任页与主界面共用的备用屏幕。调用方 start 一次，结束时 stop。 */
export function createScreen(workspaceRoot: string): ViewportTUI {
  return new TuiAltScreen(new ProcessTerminal(), false, workspaceRoot);
}
