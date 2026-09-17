import {
	allocateStackSizes,
	LAYOUT_NODE,
	visibleStackEntries,
	type LayoutViewport,
	type StackLayoutEntry,
	type StackLayoutNode,
} from "../core/layout.js";
import {
	type Component,
	Container,
	dispatchMouseEvent,
	type TUI,
	type TuiMouseDispatchResult,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "../core/tui.js";
import { applyBackgroundToLine, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../core/utils.js";
import { formatDuration } from "../../util.js";


type RenderCache = {
	childLines: string[];
	width: number;
	bgSample: string | undefined;
	lines: string[];
};

/**
 * Box component - a container that applies padding and background to all children
 */
export class Box implements Component {
	children: Component[] = [];
	private paddingX: number;
	private paddingY: number;
	private bgFn?: (text: string) => string;

	// Cache for rendered output
	private cache?: RenderCache;
	private mouseLayout?: { width: number; children: Array<{ component: Component; height: number }> };

	constructor(paddingX = 1, paddingY = 1, bgFn?: (text: string) => string) {
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.bgFn = bgFn;
	}

	addChild(component: Component): void {
		this.children.push(component);
		this.invalidateCache();
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
			this.invalidateCache();
		}
	}

	clear(): void {
		this.children = [];
		this.invalidateCache();
	}

	setBgFn(bgFn?: (text: string) => string): void {
		this.bgFn = bgFn;
		// Don't invalidate here - we'll detect bgFn changes by sampling output
	}

	private invalidateCache(): void {
		this.cache = undefined;
	}

	private matchCache(width: number, childLines: string[], bgSample: string | undefined): boolean {
		const cache = this.cache;
		return (
			!!cache &&
			cache.width === width &&
			cache.bgSample === bgSample &&
			cache.childLines.length === childLines.length &&
			cache.childLines.every((line, i) => line === childLines[i])
		);
	}

	invalidate(): void {
		this.invalidateCache();
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		const contentWidth = Math.max(1, event.width - this.paddingX * 2);
		const contentY = event.y - this.paddingY;
		const contentX = event.x - this.paddingX;
		if (contentY < 0 || contentX < 0 || contentX >= contentWidth) return undefined;

		const mouseChildren =
			this.mouseLayout?.width === contentWidth
				? this.mouseLayout.children
				: this.children.map((component) => ({ component, height: component.render(contentWidth).length }));
		let childY = 0;
		for (const { component: child, height: childHeight } of mouseChildren) {
			if (contentY >= childY && contentY < childY + childHeight) {
				return dispatchMouseEvent(child, {
					...event,
					x: contentX,
					y: contentY - childY,
					width: contentWidth,
					height: childHeight,
				});
			}
			childY += childHeight;
		}
		return undefined;
	}

	render(width: number): string[] {
		if (this.children.length === 0) {
			return [];
		}

		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const leftPad = " ".repeat(this.paddingX);

		// Render all children
		const childLines: string[] = [];
		const mouseChildren: Array<{ component: Component; height: number }> = [];
		for (const child of this.children) {
			const lines = child.render(contentWidth);
			mouseChildren.push({ component: child, height: lines.length });
			for (const line of lines) {
				childLines.push(leftPad + line);
			}
		}
		this.mouseLayout = { width: contentWidth, children: mouseChildren };

		if (childLines.length === 0) {
			return [];
		}

		// Check if bgFn output changed by sampling
		const bgSample = this.bgFn ? this.bgFn("test") : undefined;

		// Check cache validity
		if (this.matchCache(width, childLines, bgSample)) {
			return this.cache!.lines;
		}

		// Apply background and padding
		const result: string[] = [];

		// Top padding
		for (let i = 0; i < this.paddingY; i++) {
			result.push(this.applyBg("", width));
		}

		// Content
		for (const line of childLines) {
			result.push(this.applyBg(line, width));
		}

		// Bottom padding
		for (let i = 0; i < this.paddingY; i++) {
			result.push(this.applyBg("", width));
		}

		// Update cache
		this.cache = { childLines, width, bgSample, lines: result };

		return result;
	}

	private applyBg(line: string, width: number): string {
		const visLen = visibleWidth(line);
		const padNeeded = Math.max(0, width - visLen);
		const padded = line + " ".repeat(padNeeded);

		if (this.bgFn) {
			return applyBackgroundToLine(padded, width, this.bgFn);
		}
		return padded;
	}
}

/**
 * 转录块之间的统一间距行数。
 *
 * 参考实现按「相邻两块」算间隔（`gap_after_between`）：默认 1 行空白，只有连续折叠的
 * 工具行之间不留空。sph 的成员行都收在工具分组内部，对外退化成一条更简单的规则——
 * **每个块前面固定 1 行空白，块自己不留尾随空行**。用户消息、助手正文、工具汇总、
 * 提示/错误行共用这一条；各块在「有内容时」自行加，空块渲染 0 行、不占位。
 */
export const BLOCK_GAP = 1;

/**
 * Spacer component that renders empty lines
 */
export class Spacer implements Component {
	private lines: number;

	constructor(lines: number = 1) {
		this.lines = lines;
	}

	setLines(lines: number): void {
		this.lines = lines;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(_width: number): string[] {
		const result: string[] = [];
		for (let i = 0; i < this.lines; i++) {
			result.push("");
		}
		return result;
	}
}


/**
 * Text component - displays multi-line text with word wrapping
 */
export class Text implements Component {
	private text: string;
	private paddingX: number; // Left/right padding
	private paddingY: number; // Top/bottom padding
	private customBgFn?: (text: string) => string;

	// Cache for rendered output
	private cachedText?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(text: string = "", paddingX: number = 1, paddingY: number = 1, customBgFn?: (text: string) => string) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.customBgFn = customBgFn;
	}

	setText(text: string): void {
		this.text = text;
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	setCustomBgFn(customBgFn?: (text: string) => string): void {
		this.customBgFn = customBgFn;
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	invalidate(): void {
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		// Check cache
		if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
			return this.cachedLines;
		}

		// Don't render anything if there's no actual text
		if (!this.text || this.text.trim() === "") {
			const result: string[] = [];
			this.cachedText = this.text;
			this.cachedWidth = width;
			this.cachedLines = result;
			return result;
		}

		// Replace tabs with 3 spaces
		const normalizedText = this.text.replace(/\t/g, "   ");

		// Reduce margins when necessary so content and padding fit within the available width.
		const paddingX = Math.min(this.paddingX, Math.max(0, Math.floor((width - 1) / 2)));
		const contentWidth = Math.max(1, width - paddingX * 2);

		// Wrap text (this preserves ANSI codes but does NOT pad)
		const wrappedLines = wrapTextWithAnsi(normalizedText, contentWidth);

		// Add margins and background to each line
		const leftMargin = " ".repeat(paddingX);
		const rightMargin = " ".repeat(paddingX);
		const contentLines: string[] = [];

		for (const line of wrappedLines) {
			// Add margins
			const lineWithMargins = leftMargin + line + rightMargin;

			// Apply background if specified (this also pads to full width)
			if (this.customBgFn) {
				contentLines.push(applyBackgroundToLine(lineWithMargins, width, this.customBgFn));
			} else {
				// No background - just pad to width with spaces
				const visibleLen = visibleWidth(lineWithMargins);
				const paddingNeeded = Math.max(0, width - visibleLen);
				contentLines.push(lineWithMargins + " ".repeat(paddingNeeded));
			}
		}

		// Add top/bottom padding (empty lines)
		const emptyLine = " ".repeat(width);
		const emptyLines: string[] = [];
		for (let i = 0; i < this.paddingY; i++) {
			const line = this.customBgFn ? applyBackgroundToLine(emptyLine, width, this.customBgFn) : emptyLine;
			emptyLines.push(line);
		}

		const result = [...emptyLines, ...contentLines, ...emptyLines];

		// Update cache
		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedLines = result;

		return result.length > 0 ? result : [""];
	}
}


export interface StackEntryOptions {
	basis?: number | "auto";
	grow?: number;
	shrink?: number;
	minSize?: number;
	maxSize?: number;
	visible?: (viewport: LayoutViewport) => boolean;
}

export interface StackEntry extends StackEntryOptions {
	component: Component;
}

export type StackChild = Component | StackEntry;

export interface StackOptions {
	gap?: number;
	align?: "stretch" | "start" | "center" | "end";
}

function isStackEntry(child: StackChild): child is StackEntry {
	return !("render" in child);
}

function normalizeSize(value: number | undefined, fallback: number): number {
	return value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value));
}

export abstract class Stack extends Container {
	protected readonly entries: StackLayoutEntry[] = [];
	protected readonly gap: number;
	protected readonly align: "stretch" | "start" | "center" | "end";
	protected abstract readonly layoutType: "vstack" | "hstack";

	constructor(children: StackChild[] = [], options: StackOptions = {}) {
		super();
		this.gap = normalizeSize(options.gap, 0);
		this.align = options.align ?? "stretch";
		for (const child of children) {
			if (isStackEntry(child)) this.addChild(child.component, child);
			else this.addChild(child);
		}
	}

	override addChild(component: Component, options: StackEntryOptions = {}): void {
		super.addChild(component);
		this.entries.push({
			component,
			...(options.basis === undefined ? {} : { basis: options.basis }),
			...(options.grow === undefined ? {} : { grow: normalizeSize(options.grow, 0) }),
			...(options.shrink === undefined ? {} : { shrink: normalizeSize(options.shrink, 1) }),
			...(options.minSize === undefined ? {} : { minSize: normalizeSize(options.minSize, 0) }),
			...(options.maxSize === undefined ? {} : { maxSize: normalizeSize(options.maxSize, Number.MAX_SAFE_INTEGER) }),
			...(options.visible === undefined ? {} : { visible: options.visible }),
		});
	}

	override removeChild(component: Component): void {
		super.removeChild(component);
		const index = this.entries.findIndex((entry) => entry.component === component);
		if (index !== -1) this.entries.splice(index, 1);
	}

	override clear(): void {
		super.clear();
		this.entries.length = 0;
	}

	[LAYOUT_NODE](): StackLayoutNode {
		return {
			type: this.layoutType,
			entries: this.entries,
			gap: this.gap,
			align: this.align,
		};
	}
}

export class VStack extends Stack {
	protected readonly layoutType = "vstack" as const;

	constructor(children: StackChild[] = [], options: StackOptions = {}) {
		super(children, options);
	}

	override render(width: number): string[] {
		const viewport = { width: Math.max(1, width), height: Number.MAX_SAFE_INTEGER };
		const entries = visibleStackEntries(this.entries, viewport);
		const rendered = entries.map((entry) => entry.component.render(viewport.width));
		const sizes = allocateStackSizes(
			entries,
			rendered.map((lines) => lines.length),
			undefined,
			this.gap,
		);
		const lines: string[] = [];
		for (let index = 0; index < entries.length; index++) {
			if (index > 0) {
				for (let gap = 0; gap < this.gap; gap++) lines.push("");
			}
			const childLines = rendered[index]!.slice(0, sizes[index]);
			lines.push(...childLines);
			for (let padding = childLines.length; padding < sizes[index]!; padding++) lines.push("");
		}
		return lines;
	}
}


export interface LoaderIndicatorOptions {
	/** Animation frames. Use an empty array to hide the indicator. */
	frames?: string[];
	/** Frame interval in milliseconds for animated indicators. */
	intervalMs?: number;
}

const DEFAULT_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DEFAULT_INTERVAL_MS = 80;

/**
 * 拆出末尾 ` (N)`。工作状态警告把次数钉在文案最后；窄行只省略正文，次数本身不裁。
 * 正文里也可以有括号（`(none)` / `(30000ms)`），只认最后一个 ` (数字)`。
 */
export function splitTrailingCount(message: string): { body: string; suffix: string } {
	const match = /^(.*) \((\d+)\)$/.exec(message);
	if (!match) return { body: message, suffix: "" };
	return { body: match[1] ?? message, suffix: ` (${match[2]})` };
}

/**
 * Loader component that updates with an optional spinning animation.
 *
 * 状态行布局：左侧转圈 + 阶段文案，最右侧本轮已运行时长。时长跟转圈共用同一
 * 个 interval，避免再开一只定时器。
 */
export class Loader extends Text {
	private frames = [...DEFAULT_FRAMES];
	private intervalMs = DEFAULT_INTERVAL_MS;
	private currentFrame = 0;
	private intervalId: NodeJS.Timeout | null = null;
	private ui: TUI | null = null;
	private renderIndicatorVerbatim = false;
	private spinnerColorFn: (str: string) => string;
	private messageColorFn: (str: string) => string;
	private message: string = "Loading...";
	private readonly startedAt = Date.now();

	constructor(
		ui: TUI,
		spinnerColorFn: (str: string) => string,
		messageColorFn: (str: string) => string,
		message: string = "Loading...",
		indicator?: LoaderIndicatorOptions,
	) {
		super("", 1, 0);
		this.ui = ui;
		this.spinnerColorFn = spinnerColorFn;
		this.messageColorFn = messageColorFn;
		this.message = message;
		this.setIndicator(indicator);
	}

	render(width: number): string[] {
		const w = Math.max(1, width);
		const leftPad = 1;
		// 右缘：1 列给滚动条 ▐，再空两格，耗时不要贴着滑块。
		const rightPad = 4;
		const inner = Math.max(1, w - leftPad - rightPad);
		const elapsed = formatDuration(Date.now() - this.startedAt);
		const { body, suffix } = splitTrailingCount(this.message);
		const suffixW = visibleWidth(suffix);
		const elapsedW = visibleWidth(elapsed);
		const gap = 2;
		// 次数优先于耗时：极窄时丢掉耗时，也不能把 `(N)` 裁成 `(1…`。
		let showElapsed = elapsedW > 0 && suffixW + elapsedW + (suffixW > 0 ? gap : 0) <= inner;
		if (suffix === "" && elapsedW <= inner) showElapsed = true;
		const shownElapsed = showElapsed ? elapsed : "";
		const shownElapsedW = showElapsed ? elapsedW : 0;
		const leftBudget = Math.max(0, inner - shownElapsedW - (showElapsed ? gap : 0));
		const frame = this.getRenderedIndicator();
		const spinner = frame.length > 0 ? `${frame} ` : "";
		const spinnerW = visibleWidth(spinner);
		const showSpinner = spinnerW > 0 && leftBudget >= spinnerW + suffixW;
		const lead = showSpinner ? spinner : "";
		const leadW = showSpinner ? spinnerW : 0;
		const bodyBudget = Math.max(0, leftBudget - leadW - suffixW);
		const clippedBody = truncateToWidth(body, bodyBudget, "…");
		const left = lead + this.messageColorFn(clippedBody) + (suffix === "" ? "" : this.messageColorFn(suffix));
		const pad = Math.max(0, inner - visibleWidth(left) - shownElapsedW);
		const elapsedStyled = shownElapsed === "" ? "" : this.messageColorFn(shownElapsed);
		let line = `${" ".repeat(leftPad)}${left}${" ".repeat(pad)}${elapsedStyled}${" ".repeat(rightPad)}`;
		const vis = visibleWidth(line);
		if (vis < w) line += " ".repeat(w - vis);
		else if (vis > w && suffix === "") line = truncateToWidth(line, w, "…");
		return ["", line];
	}

	start(): void {
		this.updateDisplay();
		this.restartAnimation();
	}

	stop(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	setMessage(message: string): void {
		this.message = message;
		this.updateDisplay();
	}

	setMessageColor(colorFn: (str: string) => string): void {
		this.messageColorFn = colorFn;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	setIndicator(indicator?: LoaderIndicatorOptions): void {
		this.renderIndicatorVerbatim = indicator !== undefined;
		this.frames = indicator?.frames !== undefined ? [...indicator.frames] : [...DEFAULT_FRAMES];
		this.intervalMs = indicator?.intervalMs && indicator.intervalMs > 0 ? indicator.intervalMs : DEFAULT_INTERVAL_MS;
		this.currentFrame = 0;
		this.start();
	}

	private restartAnimation(): void {
		this.stop();
		if (this.frames.length <= 1) {
			return;
		}
		this.intervalId = setInterval(() => {
			this.currentFrame = (this.currentFrame + 1) % this.frames.length;
			this.updateDisplay();
		}, this.intervalMs);
	}

	protected getRenderedIndicator(): string {
		const frame = this.frames[this.currentFrame] ?? "";
		return this.renderIndicatorVerbatim ? frame : this.spinnerColorFn(frame);
	}

	private updateDisplay(): void {
		const renderedFrame = this.getRenderedIndicator();
		const indicator = renderedFrame.length > 0 ? `${renderedFrame} ` : "";
		this.setText(`${indicator}${this.messageColorFn(this.message)}`);
		if (this.ui) {
			this.ui.requestRender();
		}
	}
}

export type MouseRegionHandler = (event: TuiMouseEvent) => TuiMouseEventResult | undefined;

/** Adds mouse handling to an existing component without changing its rendering. */
export class MouseRegion implements Component {
	private readonly child: Component;
	private readonly onMouse: MouseRegionHandler;

	constructor(child: Component, onMouse: MouseRegionHandler) {
		this.child = child;
		this.onMouse = onMouse;
	}

	render(width: number): string[] {
		return this.child.render(width);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | TuiMouseEventResult | undefined {
		const childResult = dispatchMouseEvent(this.child, event);
		return childResult ?? this.onMouse(event);
	}

	invalidate(): void {
		this.child.invalidate();
	}
}
