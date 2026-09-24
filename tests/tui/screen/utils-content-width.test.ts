import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UserMessageComponent } from '../../../src/plugins/sph-tui/components/user-message.js';
import { bubbleTextColumns, contentVisibleWidth, selectionLineEnd, snapBubbleSelection, sliceByColumn, stripTerminalSequences, visibleWidth } from '../../../src/tui/utils.js';

describe('contentVisibleWidth', () => {
  it('行尾铺满的空格不计入内容宽度', () => {
    const padded = `Effort set to xhigh${' '.repeat(40)}`;
    assert.equal(visibleWidth(padded), 'Effort set to xhigh'.length + 40);
    assert.equal(contentVisibleWidth(padded), 'Effort set to xhigh'.length);
  });

  it('整行空白内容宽度为 0', () => {
    assert.equal(contentVisibleWidth(' '.repeat(80)), 0);
    assert.equal(contentVisibleWidth(''), 0);
  });

  it('ANSI 着色后仍按可见字符截到 trimEnd', () => {
    const line = `\x1b[32mEffort set to xhigh\x1b[39m${' '.repeat(20)}`;
    assert.equal(contentVisibleWidth(line), 'Effort set to xhigh'.length);
  });
});

describe('用户气泡划词', () => {
  it('灰底垫行没有可复制正文，拖在灰底上落到有字的那一行', () => {
    const text = '写一个300字作文到1.txt中';
    const lines = new UserMessageComponent(text).render(80);
    const textRow = lines.findIndex((line) => stripTerminalSequences(line).includes(text));
    assert.ok(textRow > 0);
    const range = bubbleTextColumns(lines[textRow] ?? '');
    assert.ok(range);
    assert.ok(range.start > 0, '左边框和缩进不进选区');
    assert.ok(range.end > range.start);

    const fromPad = snapBubbleSelection(lines, textRow - 1, 0);
    assert.deepEqual(fromPad, { row: textRow, col: range.start });
    const acrossPad = snapBubbleSelection(lines, textRow - 1, 70);
    assert.deepEqual(acrossPad, { row: textRow, col: range.end });
    const fromRule = snapBubbleSelection(lines, textRow, 0);
    assert.equal(fromRule?.col, range.start);
  });

  it('拖到行尾填充空格上时，右缘停在最后一个字', () => {
    const text = '第一行文字';
    const padded = `   ${text}${' '.repeat(40)}`;
    assert.ok(visibleWidth(padded) > text.length);
    assert.equal(selectionLineEnd(padded), visibleWidth(`   ${text}`));
    const end = selectionLineEnd(padded);
    const selected = stripTerminalSequences(sliceByColumn(padded, 0, end, true));
    assert.equal(selected, `   ${text}`);
    assert.equal(selected.endsWith(' '), false);
  });
});
