import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applySelectionHighlight, paintScreenDiff } from '../../../src/tui/tui-alt-screen.js';
import { compositeTuiLine } from '../../../src/tui/tui.js';

describe('paintScreenDiff', () => {
  it('第一帧清屏并写出每一行', () => {
    const { buffer, fullRedraw } = paintScreenDiff({
      screen: ['a', 'b'],
      previous: [],
      previousWidth: 0,
      previousHeight: 0,
      width: 4,
      height: 2,
    });
    assert.equal(fullRedraw, true);
    assert.ok(buffer.includes('\x1b[2J'));
    assert.ok(buffer.includes('\x1b[1;1H'));
    assert.ok(buffer.includes('\x1b[2;1H'));
    assert.ok(buffer.includes('a'));
    assert.ok(buffer.includes('b'));
  });

  it('未改的行不写，改过的行清后再写', () => {
    const { buffer, fullRedraw } = paintScreenDiff({
      screen: ['a', 'B'],
      previous: ['a', 'b'],
      previousWidth: 4,
      previousHeight: 2,
      width: 4,
      height: 2,
    });
    assert.equal(fullRedraw, false);
    assert.equal(buffer.includes('\x1b[2J'), false);
    assert.equal(buffer.includes('\x1b[1;1H'), false);
    assert.ok(buffer.includes('\x1b[2;1H\x1b[49m\x1b[2KB'));
  });

  it('尺寸变了整屏重画', () => {
    const { fullRedraw } = paintScreenDiff({
      screen: ['a'],
      previous: ['a'],
      previousWidth: 4,
      previousHeight: 2,
      width: 8,
      height: 1,
    });
    assert.equal(fullRedraw, true);
  });
});

describe('applySelectionHighlight', () => {
  it('缺省反显：开头 7m，SGR 码后重申，结尾 27m 复位', () => {
    const out = applySelectionHighlight('a\x1b[95mb');
    assert.ok(out.startsWith('\x1b[7m'));
    assert.match(out, /a\x1b\[95m\x1b\[7mb/);
    assert.ok(out.endsWith('\x1b[27m'));
  });

  it('固定样式：开头铺底并换字色，文字自己的前景码被块样式盖掉，0m 重置后重申，结尾复位', () => {
    const style = { bg: '\x1b[48;5;236m', fg: '\x1b[38;5;255m' };
    const out = applySelectionHighlight('\x1b[95m紫标题\x1b[0m后续', style);
    assert.ok(out.startsWith(`${style.bg}${style.fg}`));
    // 块内文字自己的紫色被重申的块样式覆盖：先原码、再块底、再块内字色。
    assert.match(out, /\x1b\[95m\x1b\[48;5;236m\x1b\[38;5;255m紫标题/);
    assert.match(out, /\x1b\[0m\x1b\[48;5;236m\x1b\[38;5;255m后续/);
    assert.ok(out.endsWith('\x1b[39m\x1b[49m'));
  });

  it('选区内自带背景码的片段：底色在 SGR 后重申，覆盖片段自己的底', () => {
    const out = applySelectionHighlight('\x1b[41m红底字', { bg: '\x1b[100m', fg: '\x1b[30m' });
    assert.match(out, /\x1b\[41m\x1b\[100m\x1b\[30m红底字/);
  });

  it('非 SGR 序列（OSC 8 超链接）不改属性，不触发底色重申', () => {
    const out = applySelectionHighlight('\x1b]8;;https://u\x1b\\link\x1b]8;;\x1b\\', {
      bg: '\x1b[100m',
      fg: '\x1b[30m',
    });
    assert.equal(out.match(/\x1b\[100m/g)!.length, 1);
    assert.ok(out.endsWith('\x1b[39m\x1b[49m'));
  });
});

describe('CURSOR_MARKER', () => {
  it('是控件层的 APC，不含产品名', async () => {
    const { CURSOR_MARKER } = await import('../../../src/tui/tui.js');
    assert.equal(CURSOR_MARKER.includes('pi'), false);
    assert.equal(CURSOR_MARKER.includes('sph'), false);
    assert.ok(CURSOR_MARKER.includes('tui'));
  });
});

/**
 * 把一行送给最小终端模型，返回屏幕上真正看得见的格子。
 *
 * 只需要三条真终端语义：CSI 定位改光标（含 `G` 的绝对列）、写满最后一列后**延迟换行**、
 * 底稿里的列跳转前后的可见宽度按写入顺序算。合成器算错列时，差别只会体现在这里。
 */
function paintRow(line: string, width: number): string {
  const cells = Array.from({ length: width }, () => ' ');
  let col = 0;
  let pendingWrap = false;
  let index = 0;
  while (index < line.length) {
    const esc = line.indexOf('\x1b', index);
    if (esc !== index) {
      const text = line.slice(index, esc === -1 ? line.length : esc);
      for (const ch of text) {
        if (pendingWrap) {
          // 真终端：写满最后一列后再来一个字符才换行。单行模型里回到第 0 列继续盖写。
          col = 0;
          pendingWrap = false;
        }
        if (col < width) cells[col] = ch;
        if (col + 1 >= width) {
          col = width - 1;
          pendingWrap = true;
        } else {
          col += 1;
        }
      }
      if (esc === -1) break;
    }
    const csi = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(line.slice(esc));
    if (csi?.[2] === 'G') {
      pendingWrap = false;
      col = Number(csi[1] || '1') - 1;
    } else if (csi?.[2] === 'H' || csi?.[2] === 'f') {
      pendingWrap = false;
      col = Number(csi[1].split(';')[1] || '1') - 1;
    }
    if (csi) {
      index = esc + csi[0].length;
      continue;
    }
    // OSC（超链接、标题）不占格子，整体跳过。
    const osc = /^\x1b\][^\x07\x1b]*(\x07|\x1b\\)/.exec(line.slice(esc));
    index = esc + (osc?.[0].length ?? 1);
  }
  return cells.join('');
}

describe('compositeTuiLine', () => {
  const width = 40;
  const overlay = '│ Deny │';
  const overlayWidth = 8;
  const startCol = 10;

  it('底稿是普通文本时，浮层盖在 startCol 上，两侧底稿保留', () => {
    const base = 'left side of the row            right';
    const out = paintRow(compositeTuiLine(base, overlay, startCol, overlayWidth, width), width);
    assert.equal(out.slice(startCol, startCol + overlayWidth), overlay);
    assert.equal(out.slice(0, startCol), base.slice(0, startCol));
    assert.equal(out.slice(startCol + overlayWidth).trimEnd(), base.slice(startCol + overlayWidth).trimEnd());
  });

  it('底稿用列跳转画右缘滚动条时，浮层仍落在 startCol，而不是接在跳转之后写出屏幕', () => {
    // 滚动条就是这么画的（layout.ts 的 replaceScrollbarCell）：可见宽度只有一格，
    // 光标被 CHA 甩到最后一列。
    const scrollbarColumn = width - 1;
    const base = `\x1b[${scrollbarColumn + 1}G\x1b[38;5;244m█\x1b[39m`;
    const out = paintRow(compositeTuiLine(base, overlay, startCol, overlayWidth, width), width);
    assert.equal(out.slice(startCol, startCol + overlayWidth), overlay, '浮层文字必须落在 startCol');
    assert.equal(out[scrollbarColumn], '█', '滚动条那一格不许被合成挤掉');
    assert.equal(out.slice(0, startCol).trim(), '', '浮层左侧该留空');
  });

  it('底稿用列跳转右对齐计时（状态行那种写法）时，计时不会被浮层挤到行首', () => {
    const timerColumn = 25;
    const base = `text\x1b[${timerColumn + 1}G timer`;
    const out = paintRow(compositeTuiLine(base, overlay, startCol, overlayWidth, width), width);
    assert.equal(out.slice(startCol, startCol + overlayWidth), overlay);
    assert.equal(out.slice(0, startCol), 'text'.padEnd(startCol, ' '));
    assert.equal(out.slice(timerColumn, timerColumn + 6), ' timer', '跳转写下的计时仍留在它自己的列上');
  });

  it('浮层右侧的底稿正文留着，不被尾补白抹成空带', () => {
    // 以前合成会把整个右半行铺成空格：弹窗右边看着像一块深色空带，后面的转录被吃掉了。
    const base = 'LEFT'.padEnd(30, ' ') + 'RIGHT-TAIL'.padEnd(10, ' ');
    const out = paintRow(compositeTuiLine(base, overlay, startCol, overlayWidth, width), width);
    assert.equal(out.slice(startCol, startCol + overlayWidth), overlay);
    assert.equal(out.slice(30, 40), 'RIGHT-TAIL', '浮层右侧的底稿必须原样留着');
    assert.equal(out.slice(startCol + overlayWidth, 30).trim(), '');
  });
});
