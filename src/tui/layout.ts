import type { ScrollView } from "./scroll-view.js";
import { type Component, CURSOR_MARKER, compositeTuiLine } from "./tui.js";
import {
	extractAnsiCode,
	getActiveBackgroundAnsi,
	getGraphemeCellRange,
	OSC133_ZONE_PREFIX,
	sliceByColumn,
	visibleWidth,
} from "./utils.js";

/** 布局节点取值。模块内 Symbol，不注册到全局，避免和别的运行时撞名。 */
export const LAYOUT_NODE = Symbol("tui.layout-node");

export interface LayoutViewport {
	width: number;
	height: number;
}

export interface StackLayoutEntry {
	component: Component;
	basis?: number | "auto";
	grow?: number;
	shrink?: number;
	minSize?: number;
	maxSize?: number;
	visible?: (viewport: LayoutViewport) => boolean;
}

export interface StackLayoutNode {
	type: "vstack" | "hstack";
	entries: readonly StackLayoutEntry[];
	gap: number;
	align: "stretch" | "start" | "center" | "end";
}

export interface ScrollLayoutState {
	readonly scrollTop: number;
	readonly primary: boolean;
	readonly overscroll: "chain" | "contain";
	readonly viewportHeight: number;
	getContentWidth(width: number): number;
	updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void;
}

export interface ScrollLayoutNode {
	type: "scroll";
	component: Component;
	state: ScrollLayoutState;
}

export type LayoutNode = StackLayoutNode | ScrollLayoutNode;

export interface LayoutComponent extends Component {
	[LAYOUT_NODE](): LayoutNode;
}

export function getLayoutNode(component: Component): LayoutNode | undefined {
	const candidate = component as Partial<LayoutComponent>;
	return typeof candidate[LAYOUT_NODE] === "function" ? candidate[LAYOUT_NODE]() : undefined;
}

export function visibleStackEntries(
	entries: readonly StackLayoutEntry[],
	viewport: LayoutViewport,
): StackLayoutEntry[] {
	return entries.filter((entry) => entry.visible?.(viewport) ?? true);
}

function clampSize(size: number, entry: StackLayoutEntry): number {
	const min = Math.max(0, Math.floor(entry.minSize ?? 0));
	const max = Math.max(min, Math.floor(entry.maxSize ?? Number.MAX_SAFE_INTEGER));
	return Math.max(min, Math.min(max, Math.max(0, Math.floor(size))));
}

function distribute(
	sizes: number[],
	entries: readonly StackLayoutEntry[],
	amount: number,
	mode: "grow" | "shrink",
): void {
	let remaining = amount;
	while (remaining > 0) {
		const candidates = entries
			.map((entry, index) => ({ entry, index }))
			.filter(({ entry, index }) => {
				if (mode === "grow") {
					return (entry.grow ?? 0) > 0 && sizes[index]! < (entry.maxSize ?? Number.MAX_SAFE_INTEGER);
				}
				return (entry.shrink ?? 1) > 0 && sizes[index]! > (entry.minSize ?? 0);
			});
		if (candidates.length === 0) return;

		const totalWeight = candidates.reduce((sum, { entry, index }) => {
			return sum + (mode === "grow" ? (entry.grow ?? 0) : (entry.shrink ?? 1) * Math.max(1, sizes[index]!));
		}, 0);
		let distributed = 0;
		for (const { entry, index } of candidates) {
			if (remaining <= 0) break;
			const weight = mode === "grow" ? (entry.grow ?? 0) : (entry.shrink ?? 1) * Math.max(1, sizes[index]!);
			const proposed = Math.max(1, Math.floor((remaining * weight) / totalWeight));
			const capacity =
				mode === "grow"
					? (entry.maxSize ?? Number.MAX_SAFE_INTEGER) - sizes[index]!
					: sizes[index]! - (entry.minSize ?? 0);
			const delta = Math.min(remaining, proposed, capacity);
			if (delta <= 0) continue;
			sizes[index] = sizes[index]! + (mode === "grow" ? delta : -delta);
			remaining -= delta;
			distributed += delta;
		}
		if (distributed === 0) return;
	}
}

export function allocateStackSizes(
	entries: readonly StackLayoutEntry[],
	intrinsicSizes: readonly number[],
	availableSize: number | undefined,
	gap: number,
): number[] {
	const sizes = entries.map((entry, index) =>
		clampSize(
			entry.basis === undefined || entry.basis === "auto" ? (intrinsicSizes[index] ?? 0) : entry.basis,
			entry,
		),
	);
	if (availableSize === undefined) return sizes;

	const contentSize = Math.max(0, Math.floor(availableSize) - Math.max(0, entries.length - 1) * gap);
	const total = sizes.reduce((sum, size) => sum + size, 0);
	if (total < contentSize) distribute(sizes, entries, contentSize - total, "grow");
	else if (total > contentSize) distribute(sizes, entries, total - contentSize, "shrink");
	return sizes;
}

export interface LayoutRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface LayoutBox {
	component: Component;
	rect: LayoutRect;
	clip: LayoutRect;
	children: LayoutBox[];
	parent?: LayoutBox;
	lines?: readonly string[];
	lineOffset?: number;
	scrollView?: ScrollView;
	scrollContentLines?: readonly string[];
	layer: number;
}

export interface LayoutFrame {
	root: LayoutBox;
	width: number;
	height: number;
	lines: string[];
	primaryScrollView?: ScrollView;
}

export interface ScrollbarGeometry {
	column: number;
	trackTop: number;
	trackHeight: number;
	thumbTop: number;
	thumbHeight: number;
	maxScrollTop: number;
}

interface LayoutContext {
	viewport: { width: number; height: number };
	renderCache: Map<Component, Map<number, string[]>>;
	requestRender: () => void;
	primaryScrollView: ScrollView | undefined;
	contentGeneration: number;
}

interface ScrollChildCache {
	gen: number;
	width: number;
	box: LayoutBox;
	lines: string[];
	scrollTop: number;
}

const scrollChildCache = new WeakMap<ScrollView, ScrollChildCache>();

function takeScrollChildCache(
	scrollView: ScrollView,
	gen: number,
	width: number,
	scrollTop: number,
): { box: LayoutBox; lines: string[] } | undefined {
	const cached = scrollChildCache.get(scrollView);
	if (!cached || cached.gen !== gen || cached.width !== width) return undefined;
	if (cached.scrollTop !== scrollTop) {
		translateBox(cached.box, cached.scrollTop - scrollTop);
		cached.scrollTop = scrollTop;
	}
	return { box: cached.box, lines: cached.lines };
}

function putScrollChildCache(
	scrollView: ScrollView,
	gen: number,
	width: number,
	box: LayoutBox,
	lines: string[],
	scrollTop: number,
): void {
	scrollChildCache.set(scrollView, { gen, width, box, lines, scrollTop });
}

function intersect(a: LayoutRect, b: LayoutRect): LayoutRect {
	const x = Math.max(a.x, b.x);
	const y = Math.max(a.y, b.y);
	const right = Math.min(a.x + a.width, b.x + b.width);
	const bottom = Math.min(a.y + a.height, b.y + b.height);
	return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

function renderCached(context: LayoutContext, component: Component, width: number): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	let widths = context.renderCache.get(component);
	if (!widths) {
		widths = new Map<number, string[]>();
		context.renderCache.set(component, widths);
	}
	let lines = widths.get(safeWidth);
	if (!lines) {
		lines = component.render(safeWidth);
		widths.set(safeWidth, lines);
	}
	return lines;
}

function measureHeight(context: LayoutContext, component: Component, width: number): number {
	return renderCached(context, component, width).length;
}

function measureWidth(context: LayoutContext, component: Component, width: number): number {
	return renderCached(context, component, width).reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
}

function withParent(box: LayoutBox, parent: LayoutBox): LayoutBox {
	box.parent = parent;
	return box;
}

function translateBox(box: LayoutBox, deltaY: number): void {
	box.rect.y += deltaY;
	for (const child of box.children) translateBox(child, deltaY);
}

function updateClips(box: LayoutBox, parentClip: LayoutRect): void {
	box.clip = intersect(parentClip, box.rect);
	for (const child of box.children) updateClips(child, box.clip);
}

function layoutComponent(
	context: LayoutContext,
	component: Component,
	x: number,
	y: number,
	width: number,
	height: number | undefined,
	clip: LayoutRect,
): LayoutBox {
	const safeWidth = Math.max(1, Math.floor(width));
	const node = getLayoutNode(component);
	if (!node) {
		const lines = renderCached(context, component, safeWidth);
		const allocatedHeight = height === undefined ? lines.length : Math.max(0, Math.floor(height));
		let lineOffset = 0;
		if (lines.length > allocatedHeight && allocatedHeight > 0) {
			const cursorLine = lines.findIndex((line) => line.includes(CURSOR_MARKER));
			if (cursorLine >= allocatedHeight) lineOffset = cursorLine - allocatedHeight + 1;
		}
		return {
			component,
			rect: { x, y, width: safeWidth, height: allocatedHeight },
			clip: intersect(clip, { x, y, width: safeWidth, height: allocatedHeight }),
			children: [],
			lines,
			lineOffset,
			layer: 0,
		};
	}

	if (node.type === "scroll") {
		const scrollView = node.state as ScrollView;
		const contentWidth = node.state.getContentWidth(safeWidth);
		const viewportHeight = height === undefined ? 0 : Math.max(0, Math.floor(height));
		let cached = takeScrollChildCache(scrollView, context.contentGeneration, contentWidth, node.state.scrollTop);
		if (!cached) {
			const previousScrollTop = node.state.scrollTop;
			const childBox = layoutComponent(
				context,
				node.component,
				x,
				y - previousScrollTop,
				contentWidth,
				undefined,
				clip,
			);
			node.state.updateLayout(childBox.rect.height, viewportHeight || childBox.rect.height, context.requestRender);
			translateBox(childBox, previousScrollTop - node.state.scrollTop);
			cached = {
				box: childBox,
				lines: renderCached(context, node.component, contentWidth),
			};
			putScrollChildCache(
				scrollView,
				context.contentGeneration,
				contentWidth,
				childBox,
				cached.lines,
				node.state.scrollTop,
			);
		} else {
			const previousScrollTop = node.state.scrollTop;
			node.state.updateLayout(cached.box.rect.height, viewportHeight || cached.box.rect.height, context.requestRender);
			// follow-end / pin-reserve 可能在缓存命中后改 scrollTop（编辑器变高把转录视口挤矮）。
			// 不跟着平移的话，文档还停在旧偏移，下一次滚轮会从错误的 cache.scrollTop 起跳。
			if (node.state.scrollTop !== previousScrollTop) {
				translateBox(cached.box, previousScrollTop - node.state.scrollTop);
				const entry = scrollChildCache.get(scrollView);
				if (entry) entry.scrollTop = node.state.scrollTop;
			}
		}
		const childBox = cached.box;
		if (node.state.primary || !context.primaryScrollView) context.primaryScrollView = scrollView;
		const rect = { x, y, width: safeWidth, height: viewportHeight || childBox.rect.height };
		const childClip = intersect(clip, rect);
		const box: LayoutBox = {
			component,
			rect,
			clip: childClip,
			children: [childBox],
			scrollView,
			scrollContentLines: cached.lines,
			layer: 0,
		};
		childBox.parent = box;
		updateClips(childBox, childClip);
		return box;
	}

	const entries = visibleStackEntries(node.entries, context.viewport);
	const gapTotal = Math.max(0, entries.length - 1) * node.gap;
	if (node.type === "vstack") {
		const intrinsicHeights = entries.map((entry) =>
			typeof entry.basis === "number" ? entry.basis : measureHeight(context, entry.component, safeWidth),
		);
		const sizes = allocateStackSizes(entries, intrinsicHeights, height, node.gap);
		const naturalHeight = sizes.reduce((sum, size) => sum + size, 0) + gapTotal;
		const allocatedHeight = height === undefined ? naturalHeight : Math.max(0, Math.floor(height));
		const rect = { x, y, width: safeWidth, height: allocatedHeight };
		const box: LayoutBox = {
			component,
			rect,
			clip: intersect(clip, rect),
			children: [],
			layer: 0,
		};
		let childY = y;
		for (let index = 0; index < entries.length; index++) {
			box.children.push(
				withParent(
					layoutComponent(context, entries[index]!.component, x, childY, safeWidth, sizes[index]!, box.clip),
					box,
				),
			);
			childY += sizes[index]! + node.gap;
		}
		return box;
	}

	const intrinsicWidths = entries.map((entry) =>
		typeof entry.basis === "number" ? entry.basis : measureWidth(context, entry.component, safeWidth),
	);
	const widths = allocateStackSizes(entries, intrinsicWidths, safeWidth, node.gap);
	const intrinsicHeights = entries.map((entry, index) =>
		measureHeight(context, entry.component, Math.max(1, widths[index]!)),
	);
	const allocatedHeight =
		height === undefined
			? intrinsicHeights.reduce((max, childHeight) => Math.max(max, childHeight), 0)
			: Math.max(0, height);
	const rect = { x, y, width: safeWidth, height: allocatedHeight };
	const box: LayoutBox = {
		component,
		rect,
		clip: intersect(clip, rect),
		children: [],
		layer: 0,
	};
	let childX = x;
	for (let index = 0; index < entries.length; index++) {
		const naturalChildHeight = intrinsicHeights[index]!;
		const childHeight = node.align === "stretch" ? allocatedHeight : Math.min(allocatedHeight, naturalChildHeight);
		let childY = y;
		if (node.align === "center") childY += Math.floor((allocatedHeight - childHeight) / 2);
		else if (node.align === "end") childY += allocatedHeight - childHeight;
		const childWidth = widths[index]!;
		if (childWidth === 0) {
			box.children.push({
				component: entries[index]!.component,
				rect: { x: childX, y: childY, width: 0, height: childHeight },
				clip: { x: childX, y: childY, width: 0, height: 0 },
				children: [],
				parent: box,
				layer: 0,
			});
		} else {
			box.children.push(
				withParent(
					layoutComponent(context, entries[index]!.component, childX, childY, childWidth, childHeight, box.clip),
					box,
				),
			);
		}
		childX += childWidth + node.gap;
	}
	return box;
}

function replaceScrollbarCell(
	line: string,
	column: number,
	totalWidth: number,
	replacement: string,
	preserveTargetBackground: boolean,
): string {
	const graphemeRange = getGraphemeCellRange(line, column);
	const start = graphemeRange?.start ?? column;
	const end = graphemeRange?.end ?? column + 1;
	const before = sliceByColumn(line, 0, start, true);
	const target = sliceByColumn(line, start, end - start, true);
	const after = sliceByColumn(line, end, Math.max(0, totalWidth - end), true);

	let targetPrefix = "";
	let targetIndex = 0;
	while (targetIndex < target.length) {
		const ansi = extractAnsiCode(target, targetIndex);
		if (!ansi) break;
		targetPrefix += ansi.code;
		targetIndex += ansi.length;
	}
	const beforeWidth = visibleWidth(before);
	// 空隙行（转录区与输入框之间的 gap）原先用空格铺到滑块列。Windows Terminal 上
	// 这些空格会显出一条浅底，滚到最底、滑块接到 until 时最明显。缺列用 CHA 跳过去。
	const skip = Math.max(0, start - beforeWidth);
	const lead = skip > 0 ? `\x1b[${start + 1}G` : "";
	const cellPaddingBefore = " ".repeat(Math.max(0, column - start));
	const cellPaddingAfter = " ".repeat(Math.max(0, end - column - 1));
	const targetStyle = `\x1b[0m\x1b]8;;\x07${preserveTargetBackground ? getActiveBackgroundAnsi(targetPrefix) : ""}`;
	return `${before}${lead}${targetStyle}${cellPaddingBefore}${replacement}${cellPaddingAfter}${after}`;
}

export function getScrollbarGeometry(box: LayoutBox, includeHiddenAuto = false): ScrollbarGeometry | undefined {
	if (!box.scrollView || box.rect.width <= 0 || box.rect.height <= 0) return undefined;

	const view = box.scrollView;
	const scrollHeight = view.scrollHeight;
	const trackHeight = box.rect.height;
	if (trackHeight <= 0) return undefined;
	const canRevealHiddenAuto = includeHiddenAuto && view.scrollbar === "auto" && scrollHeight > trackHeight;
	if (!view.isScrollbarVisible && !canRevealHiddenAuto) return undefined;

	// 滑块比例按可滚高度（含 pin-reserve），与 grok-build total_height 一致。
	// 若只按真实内容，短对话时滑块会铺满整列，看起来像卡住。
	const documentHeight = Math.max(trackHeight, scrollHeight);
	const minThumbHeight = Math.min(2, trackHeight);
	const thumbHeight = Math.max(
		minThumbHeight,
		Math.min(trackHeight, Math.round((trackHeight * trackHeight) / documentHeight)),
	);
	const maxScrollTop = Math.max(0, scrollHeight - trackHeight);
	const maxThumbTop = trackHeight - thumbHeight;
	const thumbOffset = maxScrollTop === 0 ? 0 : Math.round((view.scrollTop / maxScrollTop) * maxThumbTop);
	const column = box.rect.x + box.rect.width - 1;
	if (column < box.clip.x || column >= box.clip.x + box.clip.width) return undefined;

	return {
		column,
		trackTop: box.rect.y,
		trackHeight,
		thumbTop: box.rect.y + thumbOffset,
		thumbHeight,
		maxScrollTop,
	};
}

/** 滚动内容可画到的右缘（不含滚动条列）。没有滚动条时就是 clip 右缘。 */
export function contentPaintRight(box: LayoutBox): number {
	const clipRight = box.clip.x + box.clip.width;
	const column = getScrollbarGeometry(box)?.column;
	return column === undefined ? clipRight : Math.min(clipRight, column);
}

function layoutRoot(box: LayoutBox): LayoutBox {
	let current = box;
	while (current.parent) current = current.parent;
	return current;
}

function findLayoutBox(box: LayoutBox, component: Component): LayoutBox | undefined {
	if (box.component === component) return box;
	for (const child of box.children) {
		const found = findLayoutBox(child, component);
		if (found) return found;
	}
	return undefined;
}

function paintScrollbar(box: LayoutBox, screen: string[], totalWidth: number): void {
	const geometry = getScrollbarGeometry(box);
	if (!geometry || !box.scrollView) return;

	// 只画滑块、不画轨道：整格 █ 贴在右缘，比半块 ▐ 宽一截。颜色始终中性灰，不跟滚动状态变。
	const glyph = "█";
	const thumb = box.scrollView.scrollbarThumbStyle(glyph);
	const viewBottom = geometry.trackTop + geometry.trackHeight;

	const paintRow = (row: number): void => {
		if (row < 0 || row >= screen.length) return;
		screen[row] = replaceScrollbarCell(screen[row] ?? "", geometry.column, totalWidth, thumb, true);
	};

	for (let offset = 0; offset < geometry.trackHeight; offset++) {
		const row = geometry.trackTop + offset;
		if (row < box.clip.y || row >= box.clip.y + box.clip.height) continue;
		const isThumb = row >= geometry.thumbTop && row < geometry.thumbTop + geometry.thumbHeight;
		if (isThumb) paintRow(row);
	}

	// scrollbarUntil：滑块在转录区底时，把 █ 接到 until 组件顶（对话框上沿）。
	// 吸顶（pin-reserve）同样置底：跟底时滑块本来就在轨道底，空隙行接到输入框。
	const until = box.scrollView.scrollbarUntil;
	if (!until) return;
	const untilBox = findLayoutBox(layoutRoot(box), until);
	if (!untilBox || untilBox.rect.y <= viewBottom) return;
	const thumbAtBottom = geometry.thumbTop + geometry.thumbHeight >= viewBottom;
	if (!thumbAtBottom) return;
	for (let row = viewBottom; row < untilBox.rect.y; row++) paintRow(row);
}

function paintBox(box: LayoutBox, screen: string[], totalWidth: number): void {
	if (box.lines) {
		const offset = box.lineOffset ?? 0;
		const firstRow = Math.max(box.rect.y, box.clip.y, 0);
		const lastRow = Math.min(box.rect.y + box.rect.height, box.clip.y + box.clip.height, screen.length);
		for (let row = firstRow; row < lastRow; row++) {
			const sourceLine = box.lines[offset + row - box.rect.y];
			if (sourceLine === undefined) continue;
			const line = sourceLine.replace(OSC133_ZONE_PREFIX, "");
			// Fast path: a full-width box painting onto an untouched row can use the
			// source line reference directly. Compositing here would rebuild the row
			// string through ANSI/grapheme segmentation every frame; padding is
			// unnecessary because rows are written with erase-line and the final
			// width clamp still truncates over-wide lines.
			if (box.rect.x === 0 && box.rect.width >= totalWidth && !screen[row]) {
				screen[row] = line;
			} else {
				screen[row] = compositeTuiLine(screen[row] ?? "", line, box.rect.x, box.rect.width, totalWidth);
			}
		}
	}
	for (const child of box.children) paintBox(child, screen, totalWidth);

	paintScrollbar(box, screen, totalWidth);
}

/** 在内容装饰（吸顶、选区）之后重画滑块，避免为了让列而把气泡画短一截。 */
export function compositeScrollbars(screen: string[], frame: LayoutFrame, totalWidth: number): string[] {
	const result = [...screen];
	const visit = (box: LayoutBox): void => {
		paintScrollbar(box, result, totalWidth);
		for (const child of box.children) visit(child);
	};
	visit(frame.root);
	return result;
}

export function renderLayoutFrame(
	root: Component,
	width: number,
	height: number,
	requestRender: () => void,
	contentGeneration = 0,
): LayoutFrame {
	const safeWidth = Math.max(1, Math.floor(width));
	const safeHeight = Math.max(1, Math.floor(height));
	const context: LayoutContext = {
		viewport: { width: safeWidth, height: safeHeight },
		contentGeneration,
		renderCache: new Map(),
		requestRender,
		primaryScrollView: undefined,
	};
	const rootBox = layoutComponent(context, root, 0, 0, safeWidth, safeHeight, {
		x: 0,
		y: 0,
		width: safeWidth,
		height: safeHeight,
	});
	const lines = Array.from({ length: safeHeight }, () => "");
	paintBox(rootBox, lines, safeWidth);
	return {
		root: rootBox,
		width: safeWidth,
		height: safeHeight,
		lines,
		...(context.primaryScrollView === undefined ? {} : { primaryScrollView: context.primaryScrollView }),
	};
}

function containsPoint(rect: LayoutRect, x: number, y: number): boolean {
	return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

/** Return the visual hit path from the deepest component to the layout root. */
export function getLayoutBoxesAt(frame: LayoutFrame, x: number, y: number): LayoutBox[] {
	const result: Array<{ box: LayoutBox; depth: number }> = [];
	const visit = (box: LayoutBox, depth: number): void => {
		if (!containsPoint(box.clip, x, y)) return;
		result.push({ box, depth });
		for (const child of box.children) visit(child, depth + 1);
	};
	visit(frame.root, 0);
	result.sort((a, b) => b.box.layer - a.box.layer || b.depth - a.depth);
	return result.map(({ box }) => box);
}

export function getScrollViewBox(frame: LayoutFrame, scrollView: ScrollView): LayoutBox | undefined {
	const visit = (box: LayoutBox): LayoutBox | undefined => {
		if (box.scrollView === scrollView) return box;
		for (const child of box.children) {
			const match = visit(child);
			if (match) return match;
		}
		return undefined;
	};
	return visit(frame.root);
}

export function getScrollViewsAt(frame: LayoutFrame, x: number, y: number): ScrollView[] {
	const result: Array<{ scrollView: ScrollView; depth: number }> = [];
	const visit = (box: LayoutBox, depth: number): void => {
		if (!containsPoint(box.clip, x, y)) return;
		if (box.scrollView && containsPoint(box.rect, x, y)) result.push({ scrollView: box.scrollView, depth });
		for (const child of box.children) visit(child, depth + 1);
	};
	visit(frame.root, 0);
	result.sort((a, b) => b.depth - a.depth);
	return result.map((entry) => entry.scrollView);
}
