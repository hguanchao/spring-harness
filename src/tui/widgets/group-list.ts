/**
 * 可折叠分组的列表：分组头 + 条目 + 说明行。
 *
 * 行文本由宿主**先上好色**再交进来，列表只负责缩进、折叠字形、截断、右列对齐、选中底色与
 * 滚动视口。这样它不依赖任何主题实现，也不认识报告、菜单这些概念。
 *
 * 为什么不扩展 SelectList：那个的行模型是为「菜单」长的——选中指针槽、号槽、主列 + 说明列的
 * 两栏排版、内嵌 `(n/m)` 行。报告需要的是分组头（折叠字形 + 计数）、缩进层级、条目下的灰色
 * 注脚，往 SelectList 上叠这些分支会同时改到编辑器补全菜单、内联菜单与浮层选择弹窗，而它是
 * 三套宿主里最不该动的那一个。这里是**新建共用件**：将来另两个宿主改用本组件，改的是宿主。
 *
 * 折叠字形用 `▸` / `▾`，与转录区工具组的开合同一套。同一个屏幕上不该有两种"开合"的表达。
 */

import type { Component, TuiMouseEvent, TuiMouseEventResult } from '@/tui/screen/tui.js';
import { applyBackgroundToLine, truncateToWidth, visibleWidth } from '@/tui/text/utils.js';

/** 折叠字形。收起指右、展开指下，与工具组的箭头同一套语汇。 */
export const FOLD_MARK = { collapsed: '▸', expanded: '▾' } as const;

/** 每层缩进的列数。 */
const INDENT = 2;

/** 折叠字形占的列数（字形 1 列 + 其后 1 个空格）。非分组行留同宽空槽，标签才会对齐。 */
const GUTTER = 2;

export type GroupRowKind = 'group' | 'item' | 'note';

export interface GroupRow {
	/** 稳定身份：宿主靠它回写选中项、以及判断点到了哪一组。 */
	key: string;
	kind: GroupRowKind;
	/** 缩进层数，每层 2 列。 */
	indent?: number;
	/** 分组头是否展开，决定画 `▸` 还是 `▾`；非分组行忽略。 */
	expanded?: boolean;
	/** 主文本，**已上色**。列表按剩余宽度截断。 */
	text: string;
	/** 右对齐尾列，**已上色**；放不下时整列舍弃，不挤占主文本。 */
	trailing?: string;
	/** 不可选（说明行、空态行）：跳过高亮、确认与点选。 */
	disabled?: boolean;
}

export interface GroupListTheme {
	/** 选中行整行底色。 */
	selectedBg: (text: string) => string;
	/** 悬停行整行底色，比选中浅一档。 */
	hoverBg: (text: string) => string;
	/** 折叠字形着色。 */
	fold: (text: string) => string;
}

/**
 * 从 `from` 起朝 `direction` 找最近的可选行；全是不可选行时返回 undefined。
 *
 * `includeSelf` 决定 `from` 本身算不算候选：初始选中与换表锚定要含自身
 * （否则永远错过第 0 行），move 这类「从当前位置出发」的语义不含。
 */
function nearestSelectable(
	rows: readonly GroupRow[],
	from: number,
	direction: 1 | -1,
	wrap: boolean,
	includeSelf = false,
): number | undefined {
	const total = rows.length;
	if (total === 0) return undefined;
	let index = from;
	if (includeSelf && rows[index]?.disabled !== true) return index;
	for (let step = 0; step < total; step++) {
		const next = index + direction;
		if (next < 0 || next >= total) {
			if (!wrap) return undefined;
			index = next < 0 ? total - 1 : 0;
		} else {
			index = next;
		}
		if (rows[index]?.disabled !== true) return index;
	}
	return undefined;
}

export class GroupList implements Component {
	private rows: readonly GroupRow[];
	private selected = 0;
	/** 悬停行只画预览底色，不动高亮——可视区跟着高亮走，跟悬停走会晕。 */
	private hovered: number | undefined;
	private maxVisible: number;

	/** 确认（Enter）：宿主据此折叠/展开或什么都不做。 */
	onActivate?: (row: GroupRow) => void;

	constructor(rows: readonly GroupRow[], private readonly theme: GroupListTheme, maxVisible = 10) {
		this.rows = rows;
		this.maxVisible = Math.max(1, Math.floor(maxVisible));
		this.selected = nearestSelectable(rows, 0, 1, true, true) ?? 0;
	}

	/** 整表更换（切 tab、检索结果变化）。选中项会重新夹到最近的可选行上。 */
	setRows(rows: readonly GroupRow[]): void {
		const anchor = this.selectedRow();
		this.rows = rows;
		const kept = anchor === undefined ? undefined : rows.findIndex((row) => row.key === anchor.key);
		const from = kept !== undefined && kept >= 0 ? kept : Math.min(this.selected, rows.length - 1);
		this.selected = nearestSelectable(rows, Math.max(0, from), 1, true, true) ?? 0;
		this.hovered = undefined;
	}

	setMaxVisible(maxVisible: number): void {
		this.maxVisible = Math.max(1, Math.floor(maxVisible));
	}

	get rowCount(): number {
		return this.rows.length;
	}

	get selectedIndex(): number {
		return this.selected;
	}

	selectedRow(): GroupRow | undefined {
		return this.rows[this.selected];
	}

	setSelectedIndex(index: number): void {
		this.selected = Math.max(0, Math.min(index, this.rows.length - 1));
	}

	/**
	 * 移动高亮。
	 *
	 * 键盘**回卷**（到底再往下回到开头），滚轮不回卷——滚到边界就停，滚过头会带着可视区
	 * 一起翻页。两处手感不同是有意的。
	 */
	move(delta: 1 | -1, wrap: boolean): boolean {
		const next = nearestSelectable(this.rows, this.selected, delta, wrap);
		if (next === undefined || next === this.selected) return false;
		this.selected = next;
		this.hovered = undefined;
		return true;
	}

	/** 翻页：朝方向连走 `|delta|` 步，撞到边界就停（不回卷——翻页越过边界会跳回开头，晕）。 */
	page(delta: number): boolean {
		const step: 1 | -1 = delta >= 0 ? 1 : -1;
		let moved = false;
		for (let count = 0; count < Math.abs(delta); count++) {
			if (!this.move(step, false)) break;
			moved = true;
		}
		return moved;
	}

	/** 跳到第一个/最后一个可选行。 */
	selectFirst(): void {
		this.selected = nearestSelectable(this.rows, 0, 1, true, true) ?? 0;
		this.hovered = undefined;
	}

	selectLast(): void {
		this.selected = nearestSelectable(this.rows, this.rows.length - 1, -1, true, true) ?? 0;
		this.hovered = undefined;
	}

	/** 底边框右侧的位置读数（`3/12`）；没溢出时为空串。 */
	getScrollInfo(): string {
		if (this.rows.length <= this.maxVisible) return '';
		const ordinal = this.rows.slice(0, this.selected + 1).filter((row) => row.disabled !== true).length;
		const total = this.rows.filter((row) => row.disabled !== true).length;
		return `${ordinal}/${total}`;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const { start, end } = this.visibleRange();
		const lines: string[] = [];
		for (let index = start; index < end; index++) {
			const row = this.rows[index];
			if (row === undefined) continue;
			lines.push(this.renderRow(row, width, index === this.selected, index === this.hovered));
		}
		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.rows.length === 0) return undefined;
		const { start, end } = this.visibleRange();

		if (event.type === 'wheel' && event.wheelDelta) {
			const moved = this.move(event.wheelDelta < 0 ? -1 : 1, false);
			return { handled: true, render: moved };
		}

		if (event.type === 'move') {
			const index = start + event.y;
			const target = index >= start && index < end && this.rows[index]?.disabled !== true ? index : undefined;
			if (target === this.hovered) return undefined;
			this.hovered = target;
			return { handled: true, render: true };
		}

		if (event.button !== 'left' || (event.type !== 'press' && event.type !== 'click')) return undefined;
		const index = start + event.y;
		if (index < start || index >= end) return undefined;
		const row = this.rows[index];
		if (row === undefined || row.disabled === true) return undefined;

		const changed = this.selected !== index;
		this.selected = index;
		if (event.type === 'click') this.onActivate?.(row);
		return { handled: true, render: changed || event.type === 'click', focus: true };
	}

	/** 可见区间：高亮居中，贴边时夹住。 */
	private visibleRange(): { start: number; end: number } {
		const total = this.rows.length;
		const start = Math.max(0, Math.min(this.selected - Math.floor(this.maxVisible / 2), total - this.maxVisible));
		return { start, end: Math.min(start + this.maxVisible, total) };
	}

	private renderRow(row: GroupRow, width: number, selected: boolean, hovered: boolean): string {
		const pad = ' '.repeat((row.indent ?? 0) * INDENT);
		const gutter =
			row.kind === 'group'
				? `${this.theme.fold(row.expanded === true ? FOLD_MARK.expanded : FOLD_MARK.collapsed)} `
				: ' '.repeat(GUTTER);
		const prefix = pad + gutter;

		const trailing = row.trailing === undefined || row.trailing === '' ? undefined : row.trailing;
		const trailingWidth = trailing === undefined ? 0 : visibleWidth(trailing);
		// 尾列先让位：主文本至少要剩 1 列，否则整列舍弃（挤成省略号的主文本认不出条目）。
		// 尾列自己再带右间隙 1 格，贴到右边框会粘住。
		const reserve = trailingWidth === 0 ? 0 : trailingWidth + 1;
		const prefixWidth = visibleWidth(prefix);
		const useTrailing = trailing !== undefined && width - prefixWidth - reserve >= 1;
		const labelBudget = Math.max(1, width - prefixWidth - (useTrailing ? reserve : 0));
		const label = truncateToWidth(row.text, labelBudget, '…');

		let line = prefix + label;
		if (useTrailing) {
			const gap = width - 1 - visibleWidth(line) - trailingWidth;
			if (gap >= 0) line += ' '.repeat(gap) + trailing;
		}

		const bg = selected ? this.theme.selectedBg : hovered ? this.theme.hoverBg : undefined;
		return bg === undefined ? line : applyBackgroundToLine(line, width, bg);
	}
}
