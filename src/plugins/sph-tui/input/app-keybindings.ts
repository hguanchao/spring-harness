/**
 * 应用级键位。
 *
 * 框架层只定义 tui.* 键位（编辑器/选择列表/替代屏幕导航）；应用语义的键位（中断、退出、
 * 展开工具输出…）由这里定义，不和编辑器的 tui.* 混在一张表里。
 */

import { formatKeyText, type KeyId, matchesKey } from '@/tui/index.js';

export { formatKeyText };

export type AppKeybinding =
  | 'app.interrupt'
  | 'app.exit'
  | 'app.clear'
  | 'app.tools.expand'
  | 'app.command'
  | 'app.help'
  | 'app.followUp'
  | 'app.copy'
  | 'app.approval.cycle'
  | 'app.agent.cycle';

export interface AppKeybindingDefinition {
  /** 主键位（用于提示文案）。 */
  keys: string[];
  description: string;
  /**
   * 生效上下文（帮助面板按此分组展示；同键异义时的裁决依据也写在这里）。
   * 'always' = 任何状态可用；其余为状态短语，如 'turn running'。
   */
  when: string;
}

export const APP_KEYBINDINGS: Record<AppKeybinding, AppKeybindingDefinition> = {
  'app.interrupt': {
    keys: ['escape'],
    description: 'cancel / interrupt the running turn (restores queued messages)',
    when: 'turn running',
  },
  'app.exit': { keys: ['ctrl+d'], description: 'exit', when: 'input empty' },
  'app.clear': {
    keys: ['ctrl+c'],
    description: 'interrupt the running turn / clear input / press twice to quit',
    when: 'always',
  },
  'app.tools.expand': { keys: ['ctrl+o'], description: 'expand tool output', when: 'always' },
  'app.command': { keys: ['ctrl+p'], description: 'commands', when: 'always' },
  'app.help': { keys: ['f1'], description: 'help', when: 'always' },
  'app.followUp': {
    keys: ['alt+enter'],
    description: 'queue a follow-up for after this turn',
    when: 'always',
  },
  /**
   * 键盘复制。绑在 `ctrl+shift+c`：贴近终端习惯，但部分终端会先把这个组合自己吃掉
   * （那时按键到不了这里），所以只在**有选区**时拦下——没选区就原样透传，
   * 终端的复制/中断语义不受影响。
   */
  'app.copy': {
    keys: ['ctrl+shift+c'],
    description: 'copy the selection to the system clipboard',
    when: 'selection',
  },
  'app.approval.cycle': {
    keys: ['shift+tab'],
    description: 'cycle approval mode (ask / auto / yolo)',
    when: 'always',
  },
  'app.agent.cycle': {
    keys: ['ctrl+tab'],
    description: 'cycle the session agent (research / writer / general / default)',
    when: 'turn idle',
  },
};

/** 判断一次原始按键输入是否命中某个应用动作。 */
export function matchesAppKey(data: string, action: AppKeybinding): boolean {
  return APP_KEYBINDINGS[action].keys.some((key) => matchesKey(data, key as KeyId));
}

export function appKeyText(action: AppKeybinding): string {
  return formatKeyText(APP_KEYBINDINGS[action].keys.join('/'));
}
