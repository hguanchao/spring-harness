import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LayoutBox, LayoutFrame } from '../../../src/tui/core/layout.js';
import type { Component } from '../../../src/tui/core/tui.js';
import {
  asSelectableRow,
  compositeRowSelection,
  selectRow,
} from '../../../src/tui/components/selectable-row.js';

function box(component: Component, rect: { x: number; y: number; width: number; height: number }): LayoutBox {
  return { component, rect, clip: { ...rect }, children: [], layer: 0 };
}

function frame(root: LayoutBox, width = 20, height = 8): LayoutFrame {
  return { root, width, height, lines: [] };
}

function blank(rows: number, cols: number): string[] {
  return Array.from({ length: rows }, () => ' '.repeat(cols));
}

/**
 * 只当身份标记用的假组件。
 *
 * 这两条用例关心的是「选择标记画在哪一行、滚出裁剪区要不要画」，组件自身行为无关紧要，
 * 所以给一个最小可用实现——`Component` 要求 `render` 与 `invalidate` 两个成员，
 * 少了 `invalidate` 编译期就不成立（此前靠 tsx 不做类型检查才漏过去）。
 */
function stubRow(): Component {
  return { render: () => [''], invalidate() {} };
}

describe('compositeRowSelection', () => {
  it('只在标题行画 ❙，不顺着展开后的正文往下铺', () => {
    const row = asSelectableRow(stubRow());
    selectRow(row);
    const screen = blank(8, 20);
    const out = compositeRowSelection(
      screen,
      frame(box(row, { x: 0, y: 2, width: 20, height: 5 })),
      20,
    );
    assert.match(out[2] ?? '', /❙/);
    assert.equal(out[3], screen[3], '正文行不应被 ❙ 盖住');
    assert.equal(out[4], screen[4]);
    assert.equal(out[5], screen[5]);
    assert.equal(out[6], screen[6]);
    selectRow(undefined);
  });

  it('标题滚出裁剪区时不画', () => {
    const row = asSelectableRow(stubRow());
    selectRow(row);
    const root = box(row, { x: 0, y: 0, width: 20, height: 4 });
    root.clip = { x: 0, y: 2, width: 20, height: 2 };
    const screen = blank(8, 20);
    const out = compositeRowSelection(screen, frame(root), 20);
    assert.deepEqual(out, screen);
    selectRow(undefined);
  });
});
