/**
 * 应用级键位。
 *
 * 框架层只定义 tui.* 键位（编辑器/选择列表/替代屏幕导航）；应用语义的键位（中断、退出、
 * 展开工具输出…）由这里定义，参考实现 pi 也是同样的分层。
 */

import { formatKeyText, type KeyId, matchesKey } from './core/index.js';

export { formatKeyText };

export type AppKeybinding =
  | 'app.interrupt'
  | 'app.exit'
  | 'app.clear'
  | 'app.tools.expand'
  | 'app.command'
  | 'app.help'
  | 'app.followUp';

export interface AppKeybindingDefinition {
  /** 主键位（用于提示文案）。 */
  keys: string[];
  description: string;
}

export const APP_KEYBINDINGS: Record<AppKeybinding, AppKeybindingDefinition> = {
  'app.interrupt': { keys: ['escape'], description: 'cancel / interrupt the running turn' },
  'app.exit': { keys: ['ctrl+d'], description: 'exit' },
  'app.clear': { keys: ['ctrl+c'], description: 'interrupt the running turn / clear input / press twice to quit' },
  'app.tools.expand': { keys: ['ctrl+o'], description: 'expand tool output' },
  'app.command': { keys: ['ctrl+p'], description: 'commands' },
  'app.help': { keys: ['f1'], description: 'help' },
  'app.followUp': { keys: ['alt+enter'], description: 'queue a follow-up for after this turn' },
};

/** 判断一次原始按键输入是否命中某个应用动作。 */
export function matchesAppKey(data: string, action: AppKeybinding): boolean {
  return APP_KEYBINDINGS[action].keys.some((key) => matchesKey(data, key as KeyId));
}

export function appKeyText(action: AppKeybinding): string {
  return formatKeyText(APP_KEYBINDINGS[action].keys.join('/'));
}
