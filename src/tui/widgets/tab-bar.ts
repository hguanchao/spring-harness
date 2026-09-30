/**
 * 横向 tab 栏。
 *
 * 只画一条文本、并给出每一格的列区间：挂在哪、有没有边框、按什么键切换，都属于宿主。
 *
 * 折行与命中判定共用同一份 `layout`——两处各算一次，迟早会在窄终端上错开一格，
 * 而那种偏差只在特定的终端宽度上出现。
 */

import { visibleWidth } from '@/tui/text/utils.js';

/** 一个 tab 折行后占的列区间（`end` 不含）。 */
export interface TabSlot {
	index: number;
	start: number;
	end: number;
}

export interface TabBarTheme {
	/** 选中态。 */
	active: (text: string) => string;
	/** 未选中态。 */
	inactive: (text: string) => string;
}

/** tab 之间的间隙列数。太窄会让相邻标签糊成一个长词。 */
const GAP = 3;

export class TabBar {
	private activeIndex = 0;

	constructor(
		private readonly labels: readonly string[],
		private readonly theme: TabBarTheme,
	) {}

	get count(): number {
		return this.labels.length;
	}

	get active(): number {
		return this.activeIndex;
	}

	/** 落在有效范围内才生效；越界一律夹住，调用方不必自己判。 */
	setActive(index: number): void {
		if (this.labels.length === 0) return;
		this.activeIndex = Math.max(0, Math.min(index, this.labels.length - 1));
	}

	next(): number {
		this.setActive((this.activeIndex + 1) % Math.max(1, this.labels.length));
		return this.activeIndex;
	}

	prev(): number {
		const count = Math.max(1, this.labels.length);
		this.setActive((this.activeIndex - 1 + count) % count);
		return this.activeIndex;
	}

	/**
	 * 按可用宽度折行后的布局。
	 *
	 * 单条标签比整行还宽时**整条舍弃**而不是截断：截断后的标签认不出是哪一栏，
	 * 点上去还会切到一个用户没打算去的 tab。
	 */
	layout(width: number): TabSlot[][] {
		const rows: TabSlot[][] = [];
		let row: TabSlot[] = [];
		let column = 0;

		this.labels.forEach((label, index) => {
			const labelWidth = visibleWidth(label);
			const start = row.length === 0 ? 0 : column + GAP;
			const end = start + labelWidth;
			if (end > width) {
				if (row.length > 0) {
					rows.push(row);
					row = [];
					column = 0;
				}
				// 换行之后仍然装不下，说明这一条在当前宽度下没有位置。
				if (labelWidth > width) return;
				row.push({ index, start: 0, end: labelWidth });
				column = labelWidth;
				return;
			}
			row.push({ index, start, end });
			column = end;
		});

		if (row.length > 0) rows.push(row);
		return rows;
	}

	render(width: number): string[] {
		const lines: string[] = [];
		for (const row of this.layout(width)) {
			const pieces: string[] = [];
			let column = 0;
			for (const slot of row) {
				if (slot.start > column) pieces.push(' '.repeat(slot.start - column));
				const label = this.labels[slot.index] ?? '';
				pieces.push(slot.index === this.activeIndex ? this.theme.active(label) : this.theme.inactive(label));
				column = slot.end;
			}
			lines.push(pieces.join(''));
		}
		return lines;
	}

	/** 命中哪一栏；点在间隙或空白上返回 undefined（不切 tab，也不当成关闭）。 */
	hitTest(width: number, row: number, column: number): number | undefined {
		const rows = this.layout(width);
		const target = rows[row];
		if (target === undefined) return undefined;
		return target.find((slot) => column >= slot.start && column < slot.end)?.index;
	}
}
