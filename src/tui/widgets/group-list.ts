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
 * 字形槽只说**开合**（`›` 关着 / `✦` 开着，见 {@link FOLD_MARK}）：组头、条目各按自己的开合画。
 * 光标在哪不进字形槽——它由整行底色说。两件事各占一个信道，才不会有「字形到底是光标还是开合」
 * 的含糊（条目开合与光标解耦之后，同一个字形在相邻两行里表示两回事，那是读不出来的）。
 */

import { DoubleClickTracker } from '@/tui/screen/double-click.js';
import type { Component, TuiMouseEvent, TuiMouseEventResult } from '@/tui/screen/tui.js';
import { applyBackgroundToLine, truncateToWidth, visibleWidth } from '@/tui/text/utils.js';

/**
 * 开合字形：关着 `›`、开着 `✦`。组头的开合、条目的明细开合、转录区工具组的开合共用这一对——
 * 「这组开着」和「这条明细开着」是同一句话：这一行开着。宽度都是 1 列（Neutral），
 * 字形槽固定 2 列，对齐与折行算式不受影响。
 */
export const FOLD_MARK = { collapsed: '›', expanded: '✦' } as const;

/** 每层缩进的列数。导出给宿主：折行续行要按列算对齐，不能靠猜。 */
export const GROUP_INDENT = 2;

/** 折叠字形占的列数（字形 1 列 + 其后 1 个空格）。缩进过的非分组行留同宽空槽，标签才会对齐。 */
export const GROUP_GUTTER = 2;

const INDENT = GROUP_INDENT;
const GUTTER = GROUP_GUTTER;

export type GroupRowKind = 'group' | 'item' | 'note';

export interface GroupRow {
	/** 稳定身份：宿主靠它回写选中项、以及判断点到了哪一组。 */
	key: string;
	kind: GroupRowKind;
	/** 缩进层数，每层 2 列。 */
	indent?: number;
	/**
	 * 正文前的额外列数（**不是**层数）。
	 *
	 * 折行的续行要跟上一行的正文**字段**取齐，而那个列宽不是一个 2 列的整数倍——它等于
	 * 条目缩进 + 折叠字形空槽 + 标签宽 + 间隔。用层数表达不了，所以续行给绝对列数。
	 */
	textIndent?: number;
	/** 这一行开着没开（组头=开合，条目=明细），决定画 `›` 还是 `✦`；其余行忽略。 */
	expanded?: boolean;
	/** 分组头是否可开合。false 时不画折叠字形——画一个点了没反应的控件比不画更糟。 */
	foldable?: boolean;
	/**
	 * 条目展开后有没有内容（点开时挂出来的灰明细块）。false 时不画开合字形，理由与
	 * {@link foldable} 同款：画一个「能展开」的字形却不给内容，展开的承诺就是空的。非条目行忽略。
	 */
	expandable?: boolean;
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

/** 这一行的字形槽画不画开合字形：组头看能不能开合，条目看有没有明细，其余行不画。 */
function openable(row: GroupRow): boolean {
	if (row.kind === 'group') return row.foldable !== false;
	if (row.kind === 'item') return row.expandable !== false;
	return false;
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
	/**
	 * 滚轮滚出来的视口位置（行）。`undefined` = 视口跟着高亮走（键盘语义）。
	 *
	 * 滚轮和键盘是两种意图：键盘是「选中下一条」（高亮动，视口跟着走，高亮居中）；滚轮是
	 * 「往下看看」（视口必须先动，高亮只在被滚出可见区时才贴到边上）。从前两者都走「移动高亮」，
	 * 而视口以高亮居中——于是滚 7 格面板纹丝不动、只有读数在变，第 8 格才猛滚一屏。
	 */
	private offset: number | undefined;
	/** 双击识别：单击只移高亮，双击才激活（见 onActivate）。 */
	// slopY 取 0：列表里 y 是离散的行号，相邻两行（各点一下）绝不能算双击——
	// 工具行允许 1 行偏差是因为它判的是行内位置，这里判的是「哪一行」。
	private readonly doubleClick = new DoubleClickTracker(500, 2, 0);

	/**
	 * 激活（**双击**一行，或键盘 Enter）：宿主据此折叠/展开或什么都不做。
	 *
	 * 单击只把高亮移过来——与工具行、工具组的展开手势同一套（点一下是「看着它」，
	 * 点两下才是「打开它」）。Enter 必须留着：双击是鼠标专属，砍掉它键盘就没有开合的办法了。
	 */
	onActivate?: (row: GroupRow) => void;

	constructor(rows: readonly GroupRow[], private readonly theme: GroupListTheme, maxVisible = 10) {
		this.rows = rows;
		this.maxVisible = Math.max(1, Math.floor(maxVisible));
		this.selected = nearestSelectable(rows, 0, 1, true, true) ?? 0;
	}

	/**
	 * 整表更换（切 tab、检索结果变化）。选中项会重新夹到最近的可选行上。
	 *
	 * 视口也交还给高亮：行表都换了，旧的滚动位置对不上新内容。
	 */
	setRows(rows: readonly GroupRow[]): void {
		const anchor = this.selectedRow();
		this.rows = rows;
		const kept = anchor === undefined ? undefined : rows.findIndex((row) => row.key === anchor.key);
		const from = kept !== undefined && kept >= 0 ? kept : Math.min(this.selected, rows.length - 1);
		this.selected = nearestSelectable(rows, Math.max(0, from), 1, true, true) ?? 0;
		this.hovered = undefined;
		this.offset = undefined;
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
		this.offset = undefined;
	}

	/**
	 * 移动高亮。
	 *
	 * **不回卷**：撞到边界就停。回卷有两个毛病——列表短的时候（分组缺省收起后常常只有几行）
	 * 一按就绕回去，「我在第几位」的锚点没了；而且它只作用于键盘，跟滚轮、翻页的手感不一致，
	 * 同一个列表两套边界行为。要回卷的宿主在调用前自己夹住即可，不必做成开关。
	 */
	move(delta: 1 | -1): boolean {
		const next = nearestSelectable(this.rows, this.selected, delta, false);
		if (next === undefined || next === this.selected) return false;
		this.selected = next;
		this.hovered = undefined;
		// 视口已被滚轮接管时切换成「最小滚动」：高亮走到哪边就贴哪边。否则会为了重新居中
		// 把整屏往回抽一下——滚轮刚滚下去的位置全白费。
		if (this.offset !== undefined) this.scrollIntoView();
		return true;
	}

	/**
	 * 滚轮：推视口，高亮只在被滚出可见区时才贴到边上。
	 *
	 * 一次滚几行由 `|lines|` 决定（方向看符号），宿主的 `wheelScrollLines` 配了几行就滚几行——
	 * 从前这里被压成固定 1 行，配 3 行也照走 1 行。
	 */
	scrollBy(lines: number): boolean {
		const maxStart = Math.max(0, this.rows.length - this.maxVisible);
		const current = this.visibleRange().start;
		const next = Math.max(0, Math.min(current + lines, maxStart));
		if (next === current) return false;
		this.offset = next;
		this.followSelection();
		return true;
	}

	/** 滚轮滚完，把掉出可见区的高亮拉到最近的边上；还在区内就不动——滚轮是「看」，不顺手改选中。 */
	private followSelection(): void {
		const { start, end } = this.visibleRange();
		if (this.selected >= start && this.selected < end) return;
		const above = this.selected < start;
		const next = nearestSelectable(this.rows, above ? start : end - 1, above ? 1 : -1, false, true);
		if (next !== undefined) this.selected = next;
	}

	/** 视口已由滚轮接管时：高亮走出可见区就最小滚动把它带回来（走到哪边贴哪边，不重排整屏）。 */
	private scrollIntoView(): void {
		const { start, end } = this.visibleRange();
		if (this.selected >= start && this.selected < end) return;
		const maxStart = Math.max(0, this.rows.length - this.maxVisible);
		const target = this.selected < start ? this.selected : this.selected - this.maxVisible + 1;
		this.offset = Math.max(0, Math.min(target, maxStart));
	}

	/** 翻页：朝方向连走 `|delta|` 步，撞到边界就停。 */
	page(delta: number): boolean {
		const step: 1 | -1 = delta >= 0 ? 1 : -1;
		let moved = false;
		for (let count = 0; count < Math.abs(delta); count++) {
			if (!this.move(step)) break;
			moved = true;
		}
		return moved;
	}

	/** 跳到第一个/最后一个可选行。显式跳转要把视口交还给高亮，否则滚轮用过之后会跳出行外。 */
	selectFirst(): void {
		this.selected = nearestSelectable(this.rows, 0, 1, true, true) ?? 0;
		this.hovered = undefined;
		this.offset = undefined;
	}

	selectLast(): void {
		this.selected = nearestSelectable(this.rows, this.rows.length - 1, -1, true, true) ?? 0;
		this.hovered = undefined;
		this.offset = undefined;
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
			const moved = this.scrollBy(event.wheelDelta);
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
		// 开合走双击：与工具行/工具组同一手势。`handled: true` 顺带保证这次 click 只到这里
		// 一次——双击判定依赖这个（见 DoubleClickTracker）。
		if (event.type === 'click' && this.doubleClick.accept(event.x, event.y)) this.onActivate?.(row);
		return { handled: true, render: changed || event.type === 'click', focus: true };
	}

	/**
	 * 可见区间。
	 *
	 * 两种驱动各管一段：滚轮滚过之后由 `offset` 说了算（视口跟着滚轮走，高亮只在被滚出
	 * 可见区时贴边）；否则由高亮说了算——高亮居中，贴边时夹住。
	 *
	 * 块末（选中行后面那些不可选行也是它的内容）**只兜底**：块比一屏还长、尾行落在窗口外时，
	 * 才把窗口往下推到尾行贴底。让块末参与居中会把展开变成一次上跳——明细一挂出来，窗口就跟着
	 * 块末走 k 行，屏幕上看就是「展开哪条，哪条跳到视口顶上」；收起时又落回中间，一来一回就是
	 * 上下跳。兜底之后，常见展开（明细几行）屏幕一动不动，长明细的尾行也照样露得出来。
	 */
	private visibleRange(): { start: number; end: number } {
		const total = this.rows.length;
		const maxStart = Math.max(0, total - this.maxVisible);
		if (this.offset !== undefined) {
			const start = Math.max(0, Math.min(this.offset, maxStart));
			return { start, end: Math.min(start + this.maxVisible, total) };
		}
		let anchor = this.selected;
		while (anchor + 1 < total && this.rows[anchor + 1]?.disabled === true) anchor += 1;
		// 块长 = 选中行 + 它后面那些不可选行（注脚、明细）。只有**整块比一屏还长**时才推窗口：
		// 那种块怎么摆都看不全，至少让尾行贴底；装得下的块一律不动视口。
		const blockRows = anchor - this.selected + 1;
		const centered = Math.max(0, Math.min(this.selected - Math.floor(this.maxVisible / 2), maxStart));
		const start =
			blockRows > this.maxVisible
				? Math.max(centered, Math.min(anchor - this.maxVisible + 1, maxStart))
				: centered;
		return { start, end: Math.min(start + this.maxVisible, total) };
	}

	private renderRow(row: GroupRow, width: number, selected: boolean, hovered: boolean): string {
		const depth = row.indent ?? 0;
		const pad = ' '.repeat(depth * INDENT);
		// 字形槽（2 列）：能开合的行（可开合的组头、有明细的条目）画 `›`/`✦`，其余留空——
		// 不可开合的组头、没有明细的条目在字形这一档无话可说，画了就是空承诺；注脚与折行续行
		// 留空是为了文字不掉出正文列。缩进为 0 的说明行（caption、散文块）不隶属任何条目、不垫：
		// 它跟组头的字形取齐。
		const fold = row.expanded === true ? FOLD_MARK.expanded : FOLD_MARK.collapsed;
		const gutter =
			row.kind === 'note' && depth === 0
				? ''
				: openable(row)
					? `${this.theme.fold(fold)} `
					: ' '.repeat(GUTTER);
		const prefix = pad + gutter + ' '.repeat(row.textIndent ?? 0);

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
