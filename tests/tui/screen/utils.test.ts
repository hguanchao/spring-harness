import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  clipLineToWidth,
  contentVisibleWidth,
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '../../../src/plugins/sph-tui/screen/utils.js';

describe('visibleWidth', () => {
  it('纯 ASCII 按字符数', () => {
    assert.equal(visibleWidth('hello'), 5);
    assert.equal(visibleWidth(''), 0);
  });

  it('制表符按 3 列', () => {
    assert.equal(visibleWidth('\t'), 3);
    assert.equal(visibleWidth('a\tb'), 5);
  });

  it('CJK 全宽占 2 列', () => {
    assert.equal(visibleWidth('中'), 2);
    assert.equal(visibleWidth('你好'), 4);
  });

  it('ANSI 不占列', () => {
    assert.equal(visibleWidth('\x1b[32mhi\x1b[39m'), 2);
  });
});

describe('stripTerminalSequences', () => {
  it('剥掉 CSI 和 OSC', () => {
    assert.equal(stripTerminalSequences('\x1b[32mhi\x1b[39m'), 'hi');
    assert.equal(stripTerminalSequences('\x1b]8;;https://ex\x07click\x1b]8;;\x07'), 'click');
  });
});

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

describe('truncateToWidth / sliceByColumn / clipLineToWidth', () => {
  it('ASCII 超宽加省略号，截点复位 SGR', () => {
    const truncated = truncateToWidth('abcdef', 5);
    assert.equal(stripTerminalSequences(truncated), 'ab...');
    assert.equal(visibleWidth(truncated), 5);
  });

  it('CJK 按列切，不全切半个字', () => {
    assert.equal(visibleWidth(truncateToWidth('你好世界', 5)), 5);
  });

  it('sliceByColumn 按列取段，ANSI 不进宽度', () => {
    assert.equal(sliceByColumn('hello', 1, 3), 'ell');
    assert.equal(stripTerminalSequences(sliceByColumn('\x1b[32mhello\x1b[39m', 1, 3)), 'ell');
  });

  it('clipLineToWidth 已在宽度内则原样返回', () => {
    assert.equal(clipLineToWidth('hi', 10), 'hi');
    assert.equal(visibleWidth(clipLineToWidth('abcdefghij', 4)), 4);
  });
});

describe('wrapTextWithAnsi', () => {
  it('按词换行，不超过给定列宽', () => {
    const lines = wrapTextWithAnsi('one two three four', 10);
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= 10, `${JSON.stringify(line)} width=${visibleWidth(line)}`);
    }
    assert.equal(stripTerminalSequences(lines.join(' ')).replace(/\s+/g, ' ').trim(), 'one two three four');
  });

  it('空串得到一行空', () => {
    assert.deepEqual(wrapTextWithAnsi('', 8), ['']);
  });
});
