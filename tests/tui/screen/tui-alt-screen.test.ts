import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applySelectionHighlight, paintScreenDiff } from '../../../src/plugins/sph-tui/screen/tui-alt-screen.js';

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
  it('是 sph 的 APC，不含 pi', async () => {
    const { CURSOR_MARKER } = await import('../../../src/plugins/sph-tui/screen/tui.js');
    assert.equal(CURSOR_MARKER.includes('pi'), false);
    assert.ok(CURSOR_MARKER.includes('sph'));
  });
});
