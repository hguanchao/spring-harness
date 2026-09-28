import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TuiAltScreen } from '../../../src/tui/tui-alt-screen.js';
import type { Terminal } from '../../../src/tui/terminal.js';
import { Text, VStack } from '../../../src/tui/primitives.js';
import { ScrollView } from '../../../src/tui/scroll-view.js';
import { productScreenOptions } from '../../../src/plugins/sph-tui/chrome.js';
import { UserMessageComponent } from '../../../src/plugins/sph-tui/components/user-message.js';

class FakeTerminal implements Terminal {
  private input?: (data: string) => void;
  readonly written: string[] = [];
  columns = 80;
  rows = 24;
  kittyProtocolActive = false;

  start(onInput: (data: string) => void): void {
    this.input = onInput;
  }

  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.written.push(data);
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}

  send(data: string): void {
    this.input?.(data);
  }
}

describe('真实渲染链上的滚轮与吸顶', () => {
  it('一格滚轮只走一行，平移段用滚动区而不是整屏重画', async () => {
    const terminal = new FakeTerminal();
    const ui = new TuiAltScreen(terminal, false, undefined, productScreenOptions());
    const filler = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n');
    const editor = new Text('prompt', 0, 0);
    const view = new ScrollView(new VStack([new UserMessageComponent('hello sticky'), new Text(filler, 0, 0)]), {
      follow: 'none',
      primary: true,
      scrollbar: 'auto',
    });
    const root = new VStack(
      [
        { component: view, basis: 0, grow: 1, shrink: 1, minSize: 1 },
        { component: editor, basis: 'auto', grow: 0, shrink: 0, minSize: 1 },
      ],
      { gap: 1 },
    );
    ui.setLayoutRoot(root);
    ui.start();
    try {
      ui.renderNow(true);
      view.scrollTo(8);
      ui.renderNow();
      const before = terminal.written.length;
      terminal.send('\x1b[<65;10;5M');
      await new Promise((resolve) => process.nextTick(resolve));
      assert.equal(view.scrollTop, 9, '滚轮默认一步一行');
      const painted = terminal.written.slice(before).join('');
      assert.equal(painted.includes('\x1b[1S'), false, '有滑块时不走滚动区');
    } finally {
      ui.stop({ preserveScreen: true });
    }
  });
});
