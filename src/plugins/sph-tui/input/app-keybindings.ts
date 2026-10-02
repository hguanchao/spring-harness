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
  | 'app.copy'
  | 'app.followUp'
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
  /**
   * 复制选区。为什么给两个键：`Ctrl+Shift+C` 在 Windows Terminal、iTerm2 上被终端自己
   * 截走做「复制终端选区」，应用根本收不到；`Alt+C` 是那条通路被占时的备用键。
   *
   * 只在**有选区**时才消耗按键——没有选区就放行，终端自身的复制语义才留得下来。
   * 除键位外还有一条等效通路：`/copy` 命令（键盘可发现，任何终端都能用）。
   */
  'app.copy': {
    keys: ['ctrl+shift+c', 'alt+c'],
    description: 'copy the selection',
    when: 'selection active',
  },
  'app.followUp': {
    keys: ['alt+enter'],
    description: 'queue a follow-up for after this turn',
    when: 'always',
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
