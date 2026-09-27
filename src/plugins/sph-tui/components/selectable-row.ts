/**
 * 可选中行的按压接管:工具行 / 汇总行 / 思考行 / 挂起条的标题行,左键按下在这里
 * 被消费——不再进入全屏划词路径,双击的开合由上层在松开时合成 click 完成。
 *
 * 曾经还在按下时于行首画一枚 ❙ 选中标记;实际使用里它总被读成行前缀的一部分
 * (尤其双击展开详情后,标记恰好落在工具行左侧),与 Claude Code / Codex 那类
 * 「行就是行」的观感冲突,已移除——按下只需要接管语义,不需要视觉状态。
 */

import type { Component, TuiMouseEvent, TuiMouseEventResult } from '../../../tui/tui.js';

export const SELECTABLE_ROW = Symbol.for('sph.selectable-row');

export interface SelectableRow extends Component {
  readonly [SELECTABLE_ROW]: true;
}

export function isSelectableRow(component: Component): component is SelectableRow {
  return (component as SelectableRow)[SELECTABLE_ROW] === true;
}

/** 给已有组件打上可选行标记(汇总行 / 思考行的 MouseRegion)。 */
export function asSelectableRow<T extends Component>(component: T): T & SelectableRow {
  Object.assign(component, { [SELECTABLE_ROW]: true as const });
  return component as T & SelectableRow;
}

/** 左键按下:吃掉事件,避免全屏选词路径接手(双击开合的触发面)。 */
export function handleSelectablePress(
  _component: Component,
  event: TuiMouseEvent,
): TuiMouseEventResult | undefined {
  if (event.type !== 'press' || event.button !== 'left') return undefined;
  return { handled: true };
}
