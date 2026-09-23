/**
 * 带应用键位的编辑器。
 *
 * 应用级动作（中断、退出、展开工具输出）在编辑器默认按键之前处理：
 *   - Escape 只在自动补全未展开时才当作中断；
 *   - Ctrl+D 仅在输入为空时退出；
 *   - 其余应用动作先于编辑器默认行为；
 *   - 未命中的按键交回 Editor。
 *
 * 「正在工作」不再由编辑器承载：它渲染在输入框上方的状态行里（见 InteractiveMode）。
 */

import { Editor, type EditorOptions, type EditorTheme, type TUI } from '../../../tui/index.js';
import { matchesAppKey, type AppKeybinding } from '../app-keybindings.js';

export class CustomEditor extends Editor {
  public actionHandlers: Map<AppKeybinding, () => void> = new Map();

  /** 可动态替换的专用处理器。 */
  public onEscape?: () => void;
  public onCtrlD?: () => void;

  constructor(tui: TUI, theme: EditorTheme, options?: EditorOptions) {
    super(tui, theme, options);
  }

  /** 注册某个应用动作的处理器。 */
  onAction(action: AppKeybinding, handler: () => void): void {
    this.actionHandlers.set(action, handler);
  }

  handleInput(data: string): void {
    // 中断：仅在自动补全未展开时接管，否则交给 Editor 关闭补全。
    if (matchesAppKey(data, 'app.interrupt')) {
      if (!this.isShowingAutocomplete()) {
        const handler = this.onEscape ?? this.actionHandlers.get('app.interrupt');
        if (handler) {
          handler();
          return;
        }
      }
      super.handleInput(data);
      return;
    }

    // 退出（Ctrl+D）：仅当输入为空。
    if (matchesAppKey(data, 'app.exit')) {
      if (this.getText().length === 0) {
        const handler = this.onCtrlD ?? this.actionHandlers.get('app.exit');
        if (handler) handler();
        return;
      }
      // 输入非空时落到 Editor 的「删除后一个字符」。
    }

    // 历史导航优先于应用动作：允许用户把 Ctrl+P 绑到历史而不被命令面板抢走。
    if (matchesAppKey(data, 'app.command')) {
      const handler = this.actionHandlers.get('app.command');
      if (handler && this.getText().length === 0) {
        handler();
        return;
      }
    }

    for (const [action, handler] of this.actionHandlers) {
      if (action === 'app.interrupt' || action === 'app.exit') continue;
      if (matchesAppKey(data, action)) {
        handler();
        return;
      }
    }

    super.handleInput(data);
  }
}
