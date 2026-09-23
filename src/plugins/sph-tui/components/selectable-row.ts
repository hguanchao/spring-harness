/**
 * 对话流行选中：单击工具行 / 汇总行 / 思考行时在左侧画 │，而不是反色一段词。
 * 自管视口上的软件选中，不是终端原生选区。
 */

import type { LayoutBox, LayoutFrame } from '../../../tui/layout.js';
import { compositeTuiLine, type Component, type TuiMouseEvent, type TuiMouseEventResult } from '../../../tui/tui.js';
import { theme } from '../theme/theme.js';

/** 选中条左缘：工具行 `TOOL_GROUP_INDENT` 里再左 1 列，不盖住 ●。 */
const ROW_SELECTION_INSET = 2;

export const SELECTABLE_ROW = Symbol.for('sph.selectable-row');

export interface SelectableRow extends Component {
  readonly [SELECTABLE_ROW]: true;
}

export function isSelectableRow(component: Component): component is SelectableRow {
  return (component as SelectableRow)[SELECTABLE_ROW] === true;
}

/** 给已有组件打上行选中标记（汇总行 / 思考行的 MouseRegion）。 */
export function asSelectableRow<T extends Component>(component: T): T & SelectableRow {
  Object.assign(component, { [SELECTABLE_ROW]: true as const });
  return component as T & SelectableRow;
}

let selected: Component | undefined;

/** 切换当前行选中。返回是否变化（调用方据此决定要不要重绘）。 */
export function selectRow(component: Component | undefined): boolean {
  if (selected === component) return false;
  selected = component;
  return true;
}

/** 左键按下：钉住这一行并吃掉事件，避免全屏选词路径接手。 */
export function handleSelectablePress(
  component: Component,
  event: TuiMouseEvent,
): TuiMouseEventResult | undefined {
  if (event.type !== 'press' || event.button !== 'left') return undefined;
  const changed = selectRow(component);
  return { handled: true, render: changed };
}

function findComponentBox(box: LayoutBox, component: Component): LayoutBox | undefined {
  if (box.component === component) return box;
  for (const child of box.children) {
    const hit = findComponentBox(child, component);
    if (hit) return hit;
  }
  return undefined;
}

function putGlyph(screen: string[], row: number, col: number, glyph: string, totalWidth: number): void {
  if (row < 0 || row >= screen.length || col < 0 || col >= totalWidth) return;
  screen[row] = compositeTuiLine(screen[row] ?? '', glyph, col, 1, totalWidth);
}

export function compositeRowSelection(screen: string[], frame: LayoutFrame, width: number): string[] {
  if (!selected || !isSelectableRow(selected)) return screen;
  const box = findComponentBox(frame.root, selected);
  if (!box || box.clip.width <= 0 || box.clip.height <= 0) return screen;

  // 只钉标题/汇总那一行：成员展开后 box 会变高，整列铺 ❙ 会盖住正文与吸顶气泡。
  const row = box.rect.y;
  if (row < box.clip.y || row >= box.clip.y + box.clip.height) return screen;
  const leftX = box.rect.x + Math.min(ROW_SELECTION_INSET, Math.max(0, box.rect.width - 1));
  if (leftX < box.clip.x || leftX >= box.clip.x + box.clip.width) return screen;

  const result = [...screen];
  putGlyph(result, row, leftX, theme.fg('primary', '❙'), width);
  return result;
}
