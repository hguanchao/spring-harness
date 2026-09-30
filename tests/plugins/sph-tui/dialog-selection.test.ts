import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ClipboardCopy } from '@/tui/screen/tui.js';
import { TuiAltScreen } from '@/tui/screen/tui-alt-screen.js';
import type { Terminal } from '@/tui/terminal/terminal.js';
import { Text, VStack } from '@/tui/widgets/primitives.js';

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

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

  /** 累积输出（当前帧在最后：renderNow(true) 会把每一行重写一遍）。 */
  screen(): string {
    return this.written.join('');
  }
}

/**
 * 当前帧里某段文本落在哪一格。
 *
 * 差分绘制按行写 `\x1b[行;1H\x1b[49m\x1b[2K<内容>`，所以「行号 + 该行去色后的列偏移」就是
 * 终端坐标系里的位置——浮层的内容不在布局树里，`ui.render()` 看不到它，只能这样从帧里读。
 * 行体里带着 `\x1b[0m` / OSC 8 这类内联序列，所以要切到**下一个行首**而不是下一个 ESC。
 */
const ROW_BODY = /\x1b\[(\d+);1H\x1b\[49m\x1b\[2K([\s\S]*?)(?=\x1b\[\d+;1H\x1b\[49m\x1b\[2K|$)/g;

function locate(terminal: FakeTerminal, token: string): { row: number; col: number } {
  let found: { row: number; col: number } | undefined;
  for (const match of terminal.screen().matchAll(ROW_BODY)) {
    const col = match[2]!.replace(ANSI, '').indexOf(token);
    if (col >= 0) found = { row: Number(match[1]) - 1, col };
  }
  assert.ok(found !== undefined, `当前帧里应能看到 ${token}`);
  return found;
}

/** 当前帧里这一行的原始内容（含转义序列）；最后一次写入为准。 */
function rowRaw(terminal: FakeTerminal, row: number): string {
  let body = '';
  for (const match of terminal.screen().matchAll(ROW_BODY)) {
    if (Number(match[1]) - 1 === row) body = match[2]!;
  }
  return body;
}

function pointer(terminal: FakeTerminal, x: number, y: number, phase: 'down' | 'up' | 'drag'): void {
  const button = phase === 'drag' ? 32 : 0;
  terminal.send(`\x1b[<${button};${x + 1};${y + 1}${phase === 'up' ? 'm' : 'M'}`);
}

function rightClick(terminal: FakeTerminal, x: number, y: number): void {
  terminal.send(`\x1b[<2;${x + 1};${y + 1}M`);
  terminal.send(`\x1b[<2;${x + 1};${y + 1}m`);
}

/** 复制链路是异步的（copySelection 返回 Promise），断言前先让它走完。 */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Harness {
  terminal: FakeTerminal;
  ui: TuiAltScreen;
  /** 弹窗正文那一行第一个字符的屏幕坐标。 */
  row: number;
  col: number;
}

/** 起一块屏幕：正文一行，左上角叠一个两行弹窗。用例在弹窗那一行上拖选。 */
async function withDialog(
  options: { copySelection?: (text: string) => Promise<ClipboardCopy>; onCopyFeedback?: (message: string) => void },
  run: (harness: Harness) => Promise<void>,
): Promise<void> {
  const terminal = new FakeTerminal();
  const ui = new TuiAltScreen(terminal, false, undefined, options);
  ui.setLayoutRoot(new VStack([new Text('BACKGROUND ROW TEXT', 0, 0), new Text('', 0, 0)]));
  ui.start();
  try {
    ui.showOverlay(new Text('ALPHA ONE TEXT\nBETA TWO TEXT', 0, 0), { width: 24, anchor: 'top-left' });
    ui.renderNow(true);
    const at = locate(terminal, 'ALPHA');
    await run({ terminal, ui, row: at.row, col: at.col });
  } finally {
    ui.stop({ preserveScreen: true });
  }
}

describe('浮层内的拖选', () => {
  it('在弹窗正文里拖动，选区高亮出现在这一帧（不被浮层盖掉）', async () => {
    await withDialog({}, async ({ terminal, ui, row, col }) => {
      assert.equal(ui.hasTextSelection(), false, '按下之前没有选区');
      pointer(terminal, col, row, 'down');
      pointer(terminal, col + 5, row, 'drag');
      pointer(terminal, col + 5, row, 'up');
      // 拖选只请求重绘，帧是用例自己催出来的（渲染在下一个 tick 才合并）。
      ui.renderNow(true);
      const painted = rowRaw(terminal, row);
      assert.match(painted, /\x1b\[7m/, '这一行铺出了反显高亮块');
      assert.equal(painted.replace(ANSI, '').startsWith('ALPHA'), true, '底色换了，字还是弹窗正文');
      assert.equal(ui.hasTextSelection(), true, '松开之后选区还在');
    });
  });

  it('右键复制把浮层里的文本交给宿主：已剥色、行尾无填充空格', async () => {
    const copied: string[] = [];
    const feedback: string[] = [];
    await withDialog(
      {
        copySelection: async (text) => {
          copied.push(text);
          return 'native';
        },
        onCopyFeedback: (message) => feedback.push(message),
      },
      async ({ terminal, row, col }) => {
        pointer(terminal, col, row, 'down');
        // 拖到弹窗右边框之外：整行都被选上，补白不得跟着进剪贴板。
        pointer(terminal, col + 30, row, 'drag');
        pointer(terminal, col + 30, row, 'up');
        rightClick(terminal, col + 30, row);
        await flush();
        assert.deepEqual(copied, ['ALPHA ONE TEXT'], '整段是弹窗那一行，没有右侧补白');
        assert.deepEqual(feedback, ['Copied!'], '原生通路成功才说 Copied!');
      },
    );
  });

  it('三种落点各说一句实话：没写进剪贴板就不说 Copied!', async () => {
    for (const [result, expected] of [
      ['native', 'Copied!'],
      ['osc52', 'Copied (OSC 52)'],
      ['failed', 'Copy failed'],
    ] as const) {
      const feedback: string[] = [];
      await withDialog(
        {
          copySelection: async () => result,
          onCopyFeedback: (message) => feedback.push(message),
        },
        async ({ terminal, row, col }) => {
          pointer(terminal, col, row, 'down');
          pointer(terminal, col + 3, row, 'drag');
          pointer(terminal, col + 3, row, 'up');
          rightClick(terminal, col + 3, row);
          await flush();
          assert.deepEqual(feedback, [expected], `${result} 的文案`);
        },
      );
    }
  });

  it('宿主没接剪贴板时退回 OSC 52 写出，并按同一档文案如实报告', async () => {
    const feedback: string[] = [];
    await withDialog({ onCopyFeedback: (message) => feedback.push(message) }, async ({ terminal, row, col }) => {
      pointer(terminal, col, row, 'down');
      pointer(terminal, col + 3, row, 'drag');
      pointer(terminal, col + 3, row, 'up');
      rightClick(terminal, col + 3, row);
      await flush();
      assert.match(terminal.screen(), /\x1b\]52;c;/, 'OSC 52 确实写给了终端');
      assert.deepEqual(feedback, ['Copied (OSC 52)']);
    });
  });
});
