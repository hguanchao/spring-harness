import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Component, TuiMouseEvent } from '../../../src/tui/tui.js';
import {
  asSelectableRow,
  handleSelectablePress,
  isSelectableRow,
} from '../../../src/plugins/sph-tui/components/selectable-row.js';

function pressEvent(button: 'left' | 'right' = 'left'): TuiMouseEvent {
  return {
    type: 'press',
    button,
    x: 3,
    y: 0,
    screenX: 3,
    screenY: 3,
    width: 80,
    height: 1,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

function stubRow(): Component {
  return { render: () => [''], invalidate() {} };
}

/**
 * 可选行的按压接管。行首的 ❙ 选中标记已移除——它总被读成行前缀的一部分(双击
 * 展开详情后恰好落在工具行左侧),这里只守「按下接管、其余放行」的语义。
 */
describe('可选行按压接管', () => {
  it('左键按下被接管——双击开合的触发面，不进全屏划词', () => {
    const row = asSelectableRow(stubRow());
    assert.equal(isSelectableRow(row), true);
    assert.ok(handleSelectablePress(row, pressEvent())?.handled);
  });

  it('非左键与非按压事件放行', () => {
    const row = asSelectableRow(stubRow());
    assert.equal(handleSelectablePress(row, pressEvent('right')), undefined);
    assert.equal(handleSelectablePress(row, { ...pressEvent(), type: 'click' }), undefined);
  });

  it('未打标记的组件不被认领为可选行', () => {
    assert.equal(isSelectableRow(stubRow()), false);
  });
});
