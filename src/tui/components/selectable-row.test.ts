import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LayoutBox, LayoutFrame } from '../core/layout.js';
import type { Component } from '../core/tui.js';
import {
  asSelectableRow,
  compositeRowSelection,
  selectRow,
} from './selectable-row.js';

function box(component: Component, rect: { x: number; y: number; width: number; height: number }): LayoutBox {
  return { component, rect, clip: { ...rect }, children: [], layer: 0 };
}

function frame(root: LayoutBox, width = 20, height = 8): LayoutFrame {
  return { root, width, height, lines: [] };
}

function blank(rows: number, cols: number): string[] {
  return Array.from({ length: rows }, () => ' '.repeat(cols));
}

describe('compositeRowSelection', () => {
  it('只在标题行画 │，不顺着展开后的正文往下铺', () => {
    const row = asSelectableRow({ render: () => [''] });
    selectRow(row);
    const screen = blank(8, 20);
    const out = compositeRowSelection(
      screen,
      frame(box(row, { x: 0, y: 2, width: 20, height: 5 })),
      20,
    );
    assert.match(out[2] ?? '', /│/);
    assert.equal(out[3], screen[3], '正文行不应被 │ 盖住');
    assert.equal(out[4], screen[4]);
    assert.equal(out[5], screen[5]);
    assert.equal(out[6], screen[6]);
    selectRow(undefined);
  });

  it('标题滚出裁剪区时不画', () => {
    const row = asSelectableRow({ render: () => [''] });
    selectRow(row);
    const root = box(row, { x: 0, y: 0, width: 20, height: 4 });
    root.clip = { x: 0, y: 2, width: 20, height: 2 };
    const screen = blank(8, 20);
    const out = compositeRowSelection(screen, frame(root), 20);
    assert.deepEqual(out, screen);
    selectRow(undefined);
  });
});
