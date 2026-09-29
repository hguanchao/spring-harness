import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolExecutionComponent } from '@/plugins/sph-tui/tools/tool-execution.js';
import type { Terminal } from '@/tui/terminal/terminal.js';
import { TuiAltScreen } from '@/tui/screen/tui-alt-screen.js';
import { Text, VStack } from '@/tui/widgets/primitives.js';

const STRIP = /\x1b\[[0-9;]*m/g;
const TOKEN = 'AlphaBetaToken';
const OUTSIDE = 'OutsideWordToken';

class FakeTerminal implements Terminal {
  private input?: (data: string) => void;
  readonly written: string[] = [];
  columns = 80;
  rows = 16;
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

function cell(line: string, token: string): { row: number; col: number } {
  const row = line.split('\n').findIndex((text) => text.includes(token));
  const plain = line.split('\n')[row] ?? '';
  const col = plain.indexOf(token);
  assert.ok(row >= 0 && col >= 0, `屏幕上应有 ${token}`);
  return { row, col: col + 1 };
}

/** 左键按下或松开。选词发生在第二次按下，松开前才能看到高亮还在不在。 */
function pointer(terminal: FakeTerminal, col: number, row: number, phase: 'down' | 'up'): void {
  const x = col + 1;
  const y = row + 1;
  terminal.send(`\x1b[<0;${x};${y}${phase === 'down' ? 'M' : 'm'}`);
}

function withScreen(run: (terminal: FakeTerminal, ui: TuiAltScreen, tool: ToolExecutionComponent) => void): void {
  const terminal = new FakeTerminal();
  const ui = new TuiAltScreen(terminal, false);
  const outside = new Text(OUTSIDE, 0, 0);
  const tool = new ToolExecutionComponent('read', 'c1', { path: 'A.java' }, ui);
  tool.setCompact(true);
  tool.markExecutionStarted();
  tool.updateResult({ content: TOKEN, isError: false });
  tool.setExpanded(true);
  ui.setLayoutRoot(new VStack([outside, tool]));
  ui.start();
  try {
    ui.renderNow(true);
    run(terminal, ui, tool);
  } finally {
    ui.stop({ preserveScreen: true });
  }
}

function locate(ui: TuiAltScreen, token: string): { row: number; col: number } {
  const plain = ui
    .render(80)
    .map((line) => line.replace(STRIP, ''))
    .join('\n');
  return cell(plain, token);
}

describe('工具详情的双击不选词', () => {
  it('双击详情只收起，第二次按下不出现选词高亮', () => {
    withScreen((terminal, ui, tool) => {
      const at = locate(ui, TOKEN);
      pointer(terminal, at.col, at.row, 'down');
      pointer(terminal, at.col, at.row, 'up');
      const before = terminal.written.length;
      pointer(terminal, at.col, at.row, 'down');
      ui.renderNow();
      const frame = terminal.written.slice(before).join('');
      assert.equal(frame.includes('\x1b[7m'), false, '详情上的双击不应选中单词');
      assert.equal(tool.isExpanded(), true, '松开前还不应收起');
      pointer(terminal, at.col, at.row, 'up');
      assert.equal(tool.isExpanded(), false, '双击详情应收起');
    });
  });

  it('详情仍可拖选', () => {
    withScreen((terminal, ui, tool) => {
      const detail = locate(ui, TOKEN);
      const beforeDrag = terminal.written.length;
      pointer(terminal, detail.col, detail.row, 'down');
      terminal.send(`\x1b[<32;${detail.col + 6 + 1};${detail.row + 1}M`);
      ui.renderNow();
      assert.equal(terminal.written.slice(beforeDrag).join('').includes('\x1b[7m'), true, '详情应能拖选');
      assert.equal(tool.isExpanded(), true, '拖选不应收起详情');
    });
  });

  it('工具行以外的文本仍可双击选词', () => {
    withScreen((terminal, ui) => {
      const outside = locate(ui, OUTSIDE);
      pointer(terminal, outside.col, outside.row, 'down');
      pointer(terminal, outside.col, outside.row, 'up');
      const beforeWord = terminal.written.length;
      pointer(terminal, outside.col, outside.row, 'down');
      ui.renderNow();
      assert.equal(terminal.written.slice(beforeWord).join('').includes('\x1b[7m'), true, '工具行以外的双击仍应选词');
    });
  });
});
