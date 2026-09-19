import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applySelectionHighlight } from './tui-alt-screen.js';

describe('applySelectionHighlight', () => {
  it('缺省反显：开头 7m，SGR 码后重申，结尾 27m 复位', () => {
    const out = applySelectionHighlight('a\x1b[95mb');
    assert.ok(out.startsWith('\x1b[7m'));
    assert.match(out, /a\x1b\[95m\x1b\[7mb/);
    assert.ok(out.endsWith('\x1b[27m'));
  });

  it('固定底色：开头铺底，文字前景码保留，0m 重置后重申底色，结尾 49m 复位', () => {
    const bg = '\x1b[48;5;236m';
    const out = applySelectionHighlight('\x1b[95m紫标题\x1b[0m后续', bg);
    assert.ok(out.startsWith(bg));
    assert.match(out, /\x1b\[95m\x1b\[48;5;236m紫标题/);
    assert.match(out, /\x1b\[0m\x1b\[48;5;236m后续/);
    assert.ok(out.endsWith('\x1b[49m'));
  });

  it('选区内自带背景码的片段：底色在 SGR 后重申，覆盖片段自己的底', () => {
    const out = applySelectionHighlight('\x1b[41m红底字', '\x1b[100m');
    assert.match(out, /\x1b\[41m\x1b\[100m红底字/);
  });

  it('非 SGR 序列（OSC 8 超链接）不改属性，不触发底色重申', () => {
    const out = applySelectionHighlight('\x1b]8;;https://u\x1b\\link\x1b]8;;\x1b\\', '\x1b[100m');
    assert.equal(out.match(/\x1b\[100m/g)!.length, 1);
    assert.ok(out.endsWith('\x1b[49m'));
  });
});
