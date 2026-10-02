import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderRoundedBox, visibleWidth } from '@/tui/text/utils.js';

const frame = (text: string): string => text;

describe('renderRoundedBox paddingY', () => {
  it('keeps horizontal padding while dropping top/bottom blank rows', () => {
    const lines = renderRoundedBox({
      width: 20,
      title: ' T ',
      lines: ['aaa', 'bbb'],
      frame,
      padding: 1,
      paddingY: 0,
    });
    // 上下边框 + 2 行内容：横线内侧没有空行。
    assert.equal(lines.length, 4);
    assert.match(lines[0] ?? '', /^┌─ T /);
    assert.match(lines[1] ?? '', /^│ aaa/); // 左内边距 1 列还在
    assert.match(lines[2] ?? '', /^│ bbb/);
    assert.match(lines[3] ?? '', /^└/);
  });

  it('defaults vertical padding to padding when omitted', () => {
    const lines = renderRoundedBox({
      width: 20,
      title: ' T ',
      lines: ['aaa'],
      frame,
      padding: 1,
    });
    // 上边框 + 空行 + 内容 + 空行 + 下边框。
    assert.equal(lines.length, 5);
    assert.match(lines[1] ?? '', /^│ +│$/);
  });
});

describe('renderRoundedBox bottom border width', () => {
  const LEFT_INFO = '↑↓ move · Enter select · Esc close';

  const box = (overrides: Partial<Parameters<typeof renderRoundedBox>[0]>) =>
    renderRoundedBox({
      width: 60,
      title: ' T ',
      lines: ['aaa'],
      frame,
      padding: 1,
      leftInfo: LEFT_INFO,
      ...overrides,
    });

  const assertAllRowsFit = (lines: string[], width: number): void => {
    for (const [index, line] of lines.entries()) {
      assert.equal(visibleWidth(line), width, `第 ${index} 行宽 ${visibleWidth(line)}，应为 ${width}`);
    }
  };

  it('keeps the left-hint row the full width when there is no bottom-right readout', () => {
    // 右下角没有读数位时（内联菜单列表没被截断，getScrollInfo() 返回 ''），
    // 底边曾少画一根横线：整行只有 width - 1 列，底角落在右边框左边一列、右下角开口。
    const lines = box({ bottomInfo: '', infoWidth: 0 });
    assertAllRowsFit(lines, 60);
    assert.match(lines[lines.length - 1] ?? '', /┘$/);
  });

  it('keeps the same geometry when a bottom-right readout is present', () => {
    const lines = box({ bottomInfo: '1-6/9', infoWidth: 5 });
    assertAllRowsFit(lines, 60);
    assert.match(lines[lines.length - 1] ?? '', /1-6\/9─┘$/);
  });

  it('keeps the full width when the left hint has to be truncated', () => {
    // 提示被截断（带 …）时横线只剩 3 根，仍要把整行撑满。
    const lines = box({ width: 30, bottomInfo: '', infoWidth: 0 });
    assertAllRowsFit(lines, 30);
    // 截断时 truncateToWidth 会在省略号两侧补 ANSI 复位，断言前先剥掉。
    const bottom = (lines[lines.length - 1] ?? '').replace(/\x1B\[[0-9;]*m/g, '');
    assert.match(bottom, /… ─+┘$/);
  });
});
