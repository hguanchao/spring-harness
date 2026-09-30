import { getKeybindings } from "@/tui/input/keybindings.js";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@/tui/screen/tui.js";
import { applyBackgroundToLine, ruleHeadingLine, truncateToWidth, visibleWidth } from "@/tui/text/utils.js";

const DEFAULT_PRIMARY_COLUMN_WIDTH = 32;
const PRIMARY_COLUMN_GAP = 2;
const MIN_DESCRIPTION_WIDTH = 10;

const normalizeToSingleLine = (text: string): string => text.replace(/[\r\n]+/g, " ").trim();
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));

export interface SelectItem {
	value: string;
	label: string;
	description?: string;
	/**
	 * 语气色：`danger` 把主文案画成 error 红——删除/拒绝这类破坏性选项，红是安全语义
	 * 而不是装饰。选中行的底色与加粗照常，红字叠在灰底上。
	 */
	tone?: "danger";
	/** 右对齐尾列：快捷键、别名这类次级信息，dim 色画在行最右端，放不下整个舍弃。 */
	trailing?: string;
	/**
	 * 非可选行：`header` 渲染成内嵌标签的分隔线（`─ Session ───`），`doc` 是与可选行
	 * 同列对齐的 dim 说明行，`spacer` 是空行。三者都不参与 ↑/↓ 高亮、Enter 确认与点选，
	 * 也不计入 `(n/m)`。缺省 = 可选项。
	 */
	kind?: "header" | "doc" | "spacer";
}

export interface SelectListTheme {
	description: (text: string) => string;
	scrollInfo: (text: string) => string;
	noMatch: (text: string) => string;
	/** 选中行左侧标记（`>` 指向符），位置与工具行选中条对齐。 */
	selectedMark: (mark: string) => string;
	/** 选中行主文案（纯文本，不含标记）。 */
	selectedRow: (text: string) => string;
	/** 选中行整行底色（含尾随空格，末尾复位底色）。缺省不铺底，只有标记与加粗。 */
	selectedBg?: (text: string) => string;
	/** 悬停行整行底色：比选中浅一档，鼠标扫过时的预览（对齐工具行的悬停灰条）。 */
	hoverBg?: (text: string) => string;
	/** `tone: "danger"` 的主文案着色；缺省原样输出。 */
	danger?: (text: string) => string;
}

export interface SelectListTruncatePrimaryContext {
	text: string;
	maxWidth: number;
	columnWidth: number;
	item: SelectItem;
	isSelected: boolean;
}

export interface SelectListLayoutOptions {
	minPrimaryColumnWidth?: number;
	maxPrimaryColumnWidth?: number;
	truncatePrimary?: (context: SelectListTruncatePrimaryContext) => string;
	/**
	 * 行号槽：号列宽按整表算（不是可见行），个位数左补空格而不是补零——补零看起来像 ID，
	 * 而这里它就是序号。选中态由整行底色表达（行首的 `❙` 标记早已移除）。
	 *
	 * 只给「名字不可称呼」的表用（会话 id、历史 prompt）：条目本身有名字时号是多余的一列。
	 */
	numbered?: boolean;
}

export class SelectList implements Component {
	private items: SelectItem[] = [];
	private filteredItems: SelectItem[] = [];
	private selectedIndex: number = 0;
	/** 悬停行：鼠标扫过时的预览底色，不改高亮——可视区跟着高亮走，跟悬停走会晕。 */
	private hoverIndex: number | undefined;
	private mousePressedIndex: number | undefined;
	private maxVisible: number = 5;
	private theme: SelectListTheme;
	private layout: SelectListLayoutOptions;

	public onSelect?: (item: SelectItem) => void;
	public onCancel?: () => void;
	public onSelectionChange?: (item: SelectItem) => void;
	/** 是否在正文里渲染 `(n/m)` 滚动行；嵌入边框的宿主（编辑器补全菜单）可关闭并改用 getScrollInfo。 */
	public renderScrollInfoLine = true;

	constructor(items: SelectItem[], maxVisible: number, theme: SelectListTheme, layout: SelectListLayoutOptions = {}) {
		this.items = items;
		this.filteredItems = items;
		this.maxVisible = maxVisible;
		this.theme = theme;
		this.layout = layout;
		this.normalizeSelection();
	}

	setFilter(filter: string): void {
		this.filteredItems = this.items.filter((item) => item.value.toLowerCase().startsWith(filter.toLowerCase()));
		// Reset selection when filter changes
		this.selectedIndex = 0;
		this.hoverIndex = undefined;
		this.normalizeSelection();
	}

	/** 可见行数上限；宿主按可用高度收紧它（见 dialogs 的 SelectBody）。 */
	setMaxVisible(maxVisible: number): void {
		this.maxVisible = Math.max(1, Math.floor(maxVisible));
	}

	/** 当前过滤结果条数。 */
	get itemCount(): number {
		return this.filteredItems.length;
	}

	/** 当前高亮项。过滤后为空时没有。 */
	selectedItem(): SelectItem | undefined {
		return this.filteredItems[this.selectedIndex];
	}

	setSelectedIndex(index: number): void {
		this.selectedIndex = Math.max(0, Math.min(index, this.filteredItems.length - 1));
	}

	/**
	 * 初始焦点（构造后调用一次，带非可选行跳越）：危险确认把它停在安全项上，
	 * Enter 连按不会误删——破坏性动作必须多按一次 ↓ 才够得着。
	 */
	setInitialIndex(index: number): void {
		this.selectedIndex = Math.max(0, Math.min(index, this.filteredItems.length - 1));
		this.normalizeSelection();
	}

	/** 环形移动高亮；正文占用方向键滚动时，Tab 用它切选项。自动跳过非可选行。 */
	cycle(delta: 1 | -1): void {
		this.moveSelection(delta, true);
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		const lines: string[] = [];

		// If no items match filter, show message
		if (this.filteredItems.length === 0) {
			lines.push(this.theme.noMatch("  No matches"));
			return lines;
		}

		const primaryColumnWidth = this.getPrimaryColumnWidth();

		// Calculate visible range with scrolling
		const { startIndex, endIndex } = this.getVisibleRange();

		// 行号按整表算，滚动不会让「3」换一条目；非可选行（分隔线/说明）不占号。
		const numbers = this.getRowNumbers();
		const blank = numbers.size > 0 ? " ".repeat(Math.max(...[...numbers.values()].map((text) => visibleWidth(text)))) : undefined;

		// Render visible items
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredItems[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			if (item.kind === "header") {
				lines.push(this.renderHeader(item, width));
				continue;
			}
			if (item.kind === "spacer") {
				lines.push("");
				continue;
			}
			const descriptionSingleLine = item.description ? normalizeToSingleLine(item.description) : undefined;
			if (item.kind === "doc") {
				// 说明行与可选行同列对齐，但整行 dim、无标记、永不选中。
				const plain = this.renderItem({ ...item, trailing: undefined }, false, width, descriptionSingleLine, primaryColumnWidth, blank, false);
				lines.push(this.theme.description(plain));
				continue;
			}
			lines.push(this.renderItem(item, isSelected, width, descriptionSingleLine, primaryColumnWidth, numbers.get(i), i === this.hoverIndex));
		}

		// Add scroll indicators if needed
		if ((startIndex > 0 || endIndex < this.filteredItems.length) && this.renderScrollInfoLine) {
			const scrollText = `  ${this.selectableOrdinal()}/${this.selectableCount()}`;
			// Truncate if too long for terminal
			lines.push(this.theme.scrollInfo(truncateToWidth(scrollText, width - 2, "")));
		}

		return lines;
	}

	/** 滚动状态文本（`3/15`）：仅当列表溢出可视区时非空，供宿主嵌入边框。分母只数可选行。 */
	getScrollInfo(): string {
		const { startIndex, endIndex } = this.getVisibleRange();
		return startIndex > 0 || endIndex < this.filteredItems.length
			? `${this.selectableOrdinal()}/${this.selectableCount()}`
			: "";
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.filteredItems.length === 0) return undefined;
		// 滚轮只改高亮（可视区跟着选中项走），不确认。点选同理：确认只走 Enter。
		if (event.type === "wheel" && event.wheelDelta) {
			const delta = event.wheelDelta < 0 ? -1 : 1;
			const previousIndex = this.selectedIndex;
			this.moveSelection(delta, false);
			return { handled: true, render: this.selectedIndex !== previousIndex };
		}
		// 悬停只画预览底色，不动高亮——可视区跟着高亮走，跟悬停走会晕。
		if (event.type === "move") {
			const { startIndex, endIndex } = this.getVisibleRange();
			const row = startIndex + event.y;
			const target =
				row >= startIndex && row < endIndex && this.isSelectable(this.filteredItems[row]) ? row : undefined;
			if (target === this.hoverIndex) return undefined;
			this.hoverIndex = target;
			return { handled: true, render: true };
		}
		// Hover must not change selection: the visible range is centered on it.
		if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
		const { startIndex, endIndex } = this.getVisibleRange();
		const itemIndex = startIndex + event.y;
		if (itemIndex < startIndex || itemIndex >= endIndex) return undefined;
		// 分隔线、说明行不可点选。
		if (!this.isSelectable(this.filteredItems[itemIndex])) return undefined;

		if (event.type === "press") {
			this.mousePressedIndex = itemIndex;
			if (this.selectedIndex !== itemIndex) {
				this.selectedIndex = itemIndex;
				this.notifySelectionChange();
			}
			return { handled: true, focus: true };
		}
		if (event.type === "click") {
			const clickedIndex = this.mousePressedIndex ?? itemIndex;
			this.mousePressedIndex = undefined;
			const changed = this.selectedIndex !== clickedIndex;
			this.selectedIndex = clickedIndex;
			if (changed) this.notifySelectionChange();
			return { handled: true, render: changed };
		}
		return undefined;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		// Up arrow - wrap to bottom when at top
		if (kb.matches(keyData, "tui.select.up")) {
			this.moveSelection(-1, true);
		}
		// Down arrow - wrap to top when at bottom
		else if (kb.matches(keyData, "tui.select.down")) {
			this.moveSelection(1, true);
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selectedItem = this.filteredItems[this.selectedIndex];
			if (selectedItem && this.isSelectable(selectedItem) && this.onSelect) {
				this.onSelect(selectedItem);
			}
		}
		// Escape or Ctrl+C
		else if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.onCancel) {
				this.onCancel();
			}
		}
	}

	private getVisibleRange(): { startIndex: number; endIndex: number } {
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible),
		);
		return {
			startIndex,
			endIndex: Math.min(startIndex + this.maxVisible, this.filteredItems.length),
		};
	}

	/** 可选行才参与高亮、确认与点选（见 SelectItem.kind）。 */
	private isSelectable(item: SelectItem | undefined): boolean {
		return item !== undefined && item.kind === undefined;
	}

	/** 从 from 起按 direction 环形找最近的可选行；全表都不可选时返回 undefined。 */
	private nearestSelectable(from: number, direction: 1 | -1): number | undefined {
		const n = this.filteredItems.length;
		let index = from;
		for (let step = 0; step < n; step++) {
			index = (index + direction + n) % n;
			if (this.isSelectable(this.filteredItems[index])) return index;
		}
		return undefined;
	}

	/**
	 * 移动高亮到相邻的可选行。键盘导航回卷（到底再往下就回到开头）；
	 * 滚轮不回卷——滚到边界就停，滚过头会带着可视区一起翻页，很晕。
	 */
	private moveSelection(delta: 1 | -1, wrap: boolean): void {
		const n = this.filteredItems.length;
		if (n === 0) return;
		if (wrap) {
			const next = this.nearestSelectable(this.selectedIndex, delta);
			if (next === undefined || next === this.selectedIndex) return;
			this.selectedIndex = next;
			this.notifySelectionChange();
			return;
		}
		let index = this.selectedIndex;
		while (true) {
			const next = index + delta;
			if (next < 0 || next >= n) return; // 边界：停在原地
			index = next;
			if (this.isSelectable(this.filteredItems[index])) break;
		}
		this.selectedIndex = index;
		this.notifySelectionChange();
	}

	/** 当前选中行落在非可选行上（构造/过滤后）时，挪到其后最近的可选行。 */
	private normalizeSelection(): void {
		if (this.isSelectable(this.filteredItems[this.selectedIndex])) return;
		this.selectedIndex = this.nearestSelectable(this.selectedIndex, 1) ?? Math.max(0, this.filteredItems.length - 1);
	}

	/** `(n/m)` 的分子：选中行在可选行里的序次（1 起）。 */
	private selectableOrdinal(): number {
		let ordinal = 0;
		for (let i = 0; i <= this.selectedIndex && i < this.filteredItems.length; i++) {
			if (this.isSelectable(this.filteredItems[i])) ordinal++;
		}
		return ordinal;
	}

	/** `(n/m)` 的分母：可选行总数。 */
	private selectableCount(): number {
		return this.filteredItems.reduce((count, item) => (this.isSelectable(item) ? count + 1 : count), 0);
	}

	/** 分组分隔线：`─ Group ─────…`，标签嵌在横线里，dim 色，整行铺满。 */
	/**
	 * 行号槽内容（`index → " 3"`）。没开 `numbered` 时返回空表。
	 * 宽度按整表条数定，之后不再变——滚过 9→10 那一刻整条轨往右跳一格是最刺眼的抖。
	 */
	private getRowNumbers(): Map<number, string> {
		const numbers = new Map<number, string>();
		if (this.layout.numbered !== true) return numbers;
		const total = this.filteredItems.filter((item) => this.isSelectable(item)).length;
		const digits = Math.max(1, String(total).length);
		let ordinal = 0;
		for (let index = 0; index < this.filteredItems.length; index++) {
			const item = this.filteredItems[index];
			if (item === undefined || !this.isSelectable(item)) continue;
			ordinal += 1;
			numbers.set(index, String(ordinal).padStart(digits, " "));
		}
		return numbers;
	}

	private renderHeader(item: SelectItem, width: number): string {
		// 字形与 markdown 的 h3 横线同一套（ruleHeadingLine），整屏横线只有一种画法。
		// 着色仍走 description：分组行不是可选项，不该和它们抢注意力。
		// 窄终端下标签可能比内容宽还长，先截断再上色——着色后截断会切在转义序列中间。
		const rule = ruleHeadingLine(item.label, width, (text) => text);
		return this.theme.description(truncateToWidth(rule, width, ""));
	}

	private renderItem(
		item: SelectItem,
		isSelected: boolean,
		width: number,
		descriptionSingleLine: string | undefined,
		primaryColumnWidth: number,
		rowNumber?: string,
		isHovered: boolean = false,
	): string {
		const mark = isSelected ? this.theme.selectedMark(">") : " ";
		// 号槽接在选中条后面：`>` 保持在最外一格，与工具行的选中条对齐。
		const numberSlot = rowNumber === undefined ? "" : `${this.theme.description(`${rowNumber} `)}`;
		const prefix = `${mark} ${numberSlot}`;
		const prefixWidth = 2 + (rowNumber === undefined ? 0 : visibleWidth(numberSlot));
		// 主文案着色：选中走 selectedRow（加粗）；danger 语气红只在未选中时上——
		// 选中行已经有整行底色加成，红字叠灰底留给未选中的它自己。
		const paintValue = (text: string): string => {
			if (isSelected) return this.theme.selectedRow(text);
			if (item.tone === "danger") return this.theme.danger?.(text) ?? text;
			return text;
		};
		// 尾列（快捷键/别名）贴行最右端；空间不够时整列舍弃，不挤占正文。
		const trailingText = item.trailing ? normalizeToSingleLine(item.trailing) : undefined;
		const trailingWidth = trailingText ? visibleWidth(trailingText) : 0;
		const trailingReserve = trailingText ? trailingWidth + 1 : 0;
		// 选中/悬停行整行铺底（含尾随空格，末尾复位）；行内的 SGR 只动前景和字重，不会洗掉它。
		const finishRow = (line: string): string => {
			const bg = isSelected ? this.theme.selectedBg : isHovered ? this.theme.hoverBg : undefined;
			return bg === undefined ? line : applyBackgroundToLine(line, width, bg);
		};

		// 主列 + 说明列的两栏排版：门槛从 40 降到 30——说明列承载着状态这类关键信息，
		// 窄面板下整列消失等于丢信息；真放不下时下面的 MIN_DESCRIPTION_WIDTH 兜底。
		if (descriptionSingleLine && width > 30) {
			const effectivePrimaryColumnWidth = Math.max(
				1,
				Math.min(primaryColumnWidth, width - prefixWidth - 4 - trailingReserve),
			);
			const maxPrimaryWidth = Math.max(1, effectivePrimaryColumnWidth - PRIMARY_COLUMN_GAP);
			const truncatedValue = this.truncatePrimary(item, isSelected, maxPrimaryWidth, effectivePrimaryColumnWidth);
			const truncatedValueWidth = visibleWidth(truncatedValue);
			const spacing = " ".repeat(Math.max(1, effectivePrimaryColumnWidth - truncatedValueWidth));
			const descriptionStart = prefixWidth + truncatedValueWidth + spacing.length;
			const remainingWidth = width - descriptionStart - trailingReserve - 2; // -2 for safety

			// 截断必须带省略号：空省略号会让 `200k` 变成 `200`——一个看着像真值的假信息。
			if (remainingWidth > MIN_DESCRIPTION_WIDTH) {
				const truncatedDesc = truncateToWidth(descriptionSingleLine, remainingWidth, "…");
				const descText = this.theme.description(spacing + truncatedDesc);
				let line = `${prefix}${paintValue(truncatedValue)}${descText}`;
				if (trailingText) {
					const leftEnd = descriptionStart + visibleWidth(truncatedDesc);
					const pad = " ".repeat(Math.max(1, width - 1 - trailingWidth - leftEnd));
					line += pad + this.theme.description(trailingText);
				}
				return finishRow(line);
			}
		}

		const maxWidth = width - prefixWidth - 2 - trailingReserve;
		const truncatedValue = this.truncatePrimary(item, isSelected, maxWidth, maxWidth);
		let line = `${prefix}${paintValue(truncatedValue)}`;
		if (trailingText) {
			const leftEnd = prefixWidth + visibleWidth(truncatedValue);
			const pad = " ".repeat(Math.max(1, width - 1 - trailingWidth - leftEnd));
			line += pad + this.theme.description(trailingText);
		}
		return finishRow(line);
	}

	private getPrimaryColumnWidth(): number {
		const { min, max } = this.getPrimaryColumnBounds();
		// 列宽只看可选行：分隔线整行铺满、说明行多为长句，不该把主列撑宽。
		const widestPrimary = this.filteredItems.reduce((widest, item) => {
			if (!this.isSelectable(item)) return widest;
			return Math.max(widest, visibleWidth(this.getDisplayValue(item)) + PRIMARY_COLUMN_GAP);
		}, 0);

		return clamp(widestPrimary, min, max);
	}

	private getPrimaryColumnBounds(): { min: number; max: number } {
		const rawMin =
			this.layout.minPrimaryColumnWidth ?? this.layout.maxPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH;
		const rawMax =
			this.layout.maxPrimaryColumnWidth ?? this.layout.minPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH;

		return {
			min: Math.max(1, Math.min(rawMin, rawMax)),
			max: Math.max(1, Math.max(rawMin, rawMax)),
		};
	}

	private truncatePrimary(item: SelectItem, isSelected: boolean, maxWidth: number, columnWidth: number): string {
		const displayValue = this.getDisplayValue(item);
		const truncatedValue = this.layout.truncatePrimary
			? this.layout.truncatePrimary({
					text: displayValue,
					maxWidth,
					columnWidth,
					item,
					isSelected,
				})
			: truncateToWidth(displayValue, maxWidth, "…");

		return truncateToWidth(truncatedValue, maxWidth, "…");
	}

	private getDisplayValue(item: SelectItem): string {
		return item.label || item.value;
	}

	private notifySelectionChange(): void {
		const selectedItem = this.filteredItems[this.selectedIndex];
		if (selectedItem && this.onSelectionChange) {
			this.onSelectionChange(selectedItem);
		}
	}

	getSelectedItem(): SelectItem | null {
		const item = this.filteredItems[this.selectedIndex];
		return item || null;
	}
}
