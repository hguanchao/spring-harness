import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { contentVisibleWidth, visibleWidth } from '../../../src/tui/core/utils.js';

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
