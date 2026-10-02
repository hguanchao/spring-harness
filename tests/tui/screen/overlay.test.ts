import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveOverlayMargin } from '@/tui/screen/tui.js';

describe('resolveOverlayMargin', () => {
  it('expands a number to all four sides', () => {
    assert.deepEqual(resolveOverlayMargin(3, 120, 40), { top: 3, right: 3, bottom: 3, left: 3 });
  });

  it('fills missing sides with zero and clamps negatives', () => {
    assert.deepEqual(resolveOverlayMargin({ bottom: 5 }, 120, 40), { top: 0, right: 0, bottom: 5, left: 0 });
    assert.deepEqual(resolveOverlayMargin({ top: -2, left: 7 }, 120, 40), { top: 0, right: 0, bottom: 0, left: 7 });
  });

  it('evaluates a per-frame resolver with current terminal size', () => {
    // 编辑器悬浮菜单的用法：底距跟着终端行数走。
    const spec = (_width: number, height: number) => ({ bottom: height + 2 });
    assert.deepEqual(resolveOverlayMargin(spec, 120, 24), { top: 0, right: 0, bottom: 26, left: 0 });
    assert.deepEqual(resolveOverlayMargin(spec, 90, 40), { top: 0, right: 0, bottom: 42, left: 0 });
  });

  it('treats undefined as a zero margin', () => {
    assert.deepEqual(resolveOverlayMargin(undefined, 120, 40), { top: 0, right: 0, bottom: 0, left: 0 });
  });
});
