/**
 * 基于浮层的对话框：选择列表、文本输入、确认、只读长文本。
 *
 * 参考实现 pi 为每种选择器各写一个带边框容器；这里抽出统一外壳，交互语义保持一致：
 * 浮层自动获得焦点，Esc 取消，Enter 确认，关闭即隐藏浮层。
 *
 * 高度：浮层只能整块渲染，超出的行由 overlay 从顶部裁掉——矮终端下会连圆角底边框和
 * 页脚一起消失。所以每个弹窗都按 showOverlay 的 maxHeight 领取行预算，在自己的 render
 * 里把内容排进预算内（见 rowBudget / chromeRows），长文本另配滚动视口。
 */

import {
	type Component,
	Container,
	Input,
	Markdown,
	matchesKey,
	type SelectItem,
	SelectList,
	type OverlayHandle,
	type SizeValue,
	Text,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
} from './core/index.js';
import { renderRoundedBox } from './core/utils.js';
import { getMarkdownTheme, getSelectListTheme, theme } from './theme/theme.js';

const DEFAULT_HINT = '↑/↓ select · Enter confirm · Esc cancel';
const SCROLL_HINT = '↑/↓ scroll';
/** 正文挤占列表行数时，列表至少要留下的可见行数。 */
const LIST_RESERVE_ROWS = 3;

/** 浮层高度预算（行）：与 overlayOptions 里的 maxHeight 同源，每帧按终端尺寸重算。 */
function rowBudget(tui: TUI, maxHeight: SizeValue): number {
	const rows = Math.max(1, tui.terminal.rows);
	const available = Math.max(1, rows - 2); // overlayOptions 固定 margin: 1
	const wanted =
		typeof maxHeight === 'number' ? maxHeight : Math.floor((rows * Number.parseFloat(maxHeight)) / 100);
	return Math.max(1, Math.min(Number.isFinite(wanted) ? wanted : available, available));
}

/**
 * 正文区（总高已扣掉上下边框）的纵向分配。
 *
 * 优先级：内容 > 页脚 > 留白。矮终端下先牺牲留白、再牺牲页脚——边框被裁掉时弹窗看起来
 * 是坏的，而少一行留白只是变紧凑；留白只在正文还能占到 4 行时才保留。
 */
function chromeRows(bodyHeight: number, minContentRows: number): { content: number; footer: number; spacers: number } {
	const footer = bodyHeight >= minContentRows + 1 ? 1 : 0;
	const spacers = bodyHeight - footer - 2 >= Math.max(4, minContentRows) ? 2 : 0;
	return { content: Math.max(0, bodyHeight - footer - spacers), footer, spacers };
}

/**
 * 弹窗的圆角边框盒:顶部边框嵌标题,内部竖排子组件,每行包上侧边框。
 * 边框统一 borderMuted 灰,与输入框上方补全/内联菜单盒同一视觉语言。
 */
class RoundedDialogBox extends Container {
	private readonly label: string;
	/** 底边框右侧的状态文本（如滚动位置）。子组件渲染完才取值，所以拿到的是本帧状态。 */
	private readonly bottomInfo: () => string;

	constructor(title: string, bottomInfo: () => string = () => '') {
		super();
		this.label = ` ${title} `;
		this.bottomInfo = bottomInfo;
	}

	override render(width: number): string[] {
		const inner = Math.max(1, width - 2);
		// 底边框在子组件渲染之后才拼,滚动位置之类的信息才是本帧的(与补全菜单盒同款)。
		return renderRoundedBox({
			width,
			title: this.label,
			lines: super.render(inner),
			bottomInfo: this.bottomInfo(),
			frame: (text) => theme.fg('borderMuted', text),
		});
	}

	override handleMouse(event: TuiMouseEvent) {
		// 子组件从第 2 行开始（第 1 行是上边框），鼠标坐标要跟着下移一行。
		return super.handleMouse({ ...event, y: event.y - 1 });
	}
}

/**
 * 弹窗正文：把内容排进行预算，必要时补上页脚与留白。
 *
 * 子类给出「最少要几行内容」和「按分到的行数渲染内容」——前者决定留白与页脚的取舍，
 * 后者让滚动视口、列表这类需要提前知道行数的内容自己分配。
 */
abstract class DialogBody implements Component {
	protected constructor(private readonly budget: () => number) {}

	/** 内容至少要占的行数。 */
	protected abstract minContentRows(width: number): number;

	/** 按分到的行数渲染内容；`leadingRows` 是内容之前已占用的行数（留白），鼠标坐标要加回来。 */
	protected abstract renderContent(width: number, rows: number, leadingRows: number): string[];

	/** 页脚文本。 */
	protected abstract footerText(): string;

	invalidate(): void {}

	render(width: number): string[] {
		const bodyHeight = Math.max(0, this.budget() - 2);
		if (bodyHeight === 0) return [];
		const minRows = Math.min(Math.max(1, this.minContentRows(width)), bodyHeight);
		const { content, footer, spacers } = chromeRows(bodyHeight, minRows);
		const lines = this.renderContent(width, Math.max(1, content), spacers > 0 ? 1 : 0);
		const result: string[] = [];
		if (spacers > 0) result.push('');
		result.push(...lines);
		if (spacers > 0) result.push('');
		if (footer > 0) result.push(truncateToWidth(theme.fg('dim', ` ${this.footerText()}`), width, ''));
		// 硬上限：任何情况下都不许顶穿边框。
		return result.length > bodyHeight ? result.slice(0, bodyHeight) : result;
	}
}

/**
 * 只读长文本视口：把 Markdown 渲染结果裁到分到的行数，↑/↓、PgUp/PgDn、Home/End 与滚轮
 * 滚动。行数每帧按预算重算，终端尺寸变化即时生效。
 */
class ScrollableTextBody extends DialogBody {
	private readonly markdown: Markdown;
	private readonly hint: string;
	private offset = 0;
	private contentHeight = 0;
	private viewportHeight = 0;

	constructor(text: string, budget: () => number, hint: string) {
		super(budget);
		this.markdown = new Markdown(text, 1, 0, getMarkdownTheme());
		this.hint = hint;
	}

	/** 底边框里的滚动位置 `(1-8/24)`；内容装得下时为空。 */
	getScrollInfo(): string {
		if (this.contentHeight <= this.viewportHeight) return '';
		return `(${this.offset + 1}-${this.offset + this.viewportHeight}/${this.contentHeight})`;
	}

	get scrollable(): boolean {
		return this.contentHeight > this.viewportHeight;
	}

	scrollBy(lines: number): void {
		const max = Math.max(0, this.contentHeight - this.viewportHeight);
		this.offset = Math.max(0, Math.min(max, this.offset + lines));
	}

	scrollByPage(direction: -1 | 1): void {
		this.scrollBy(direction * Math.max(1, this.viewportHeight - 1));
	}

	scrollToStart(): void {
		this.offset = 0;
	}

	scrollToEnd(): void {
		this.offset = Math.max(0, this.contentHeight - this.viewportHeight);
	}

	protected override minContentRows(): number {
		return 1;
	}

	protected override footerText(): string {
		return this.scrollable ? `${SCROLL_HINT} · ${this.hint}` : this.hint;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== 'wheel' || !event.wheelDelta) return undefined;
		this.scrollBy(event.wheelDelta);
		return { handled: true, render: true };
	}

	protected override renderContent(width: number, rows: number): string[] {
		const content = this.markdown.render(Math.max(1, width));
		this.contentHeight = content.length;
		this.viewportHeight = Math.min(rows, Math.max(1, content.length));
		this.offset = Math.max(0, Math.min(this.offset, content.length - this.viewportHeight));
		return content.slice(this.offset, this.offset + this.viewportHeight);
	}
}

/** 选择列表正文：把列表可见行数压进预算，矮终端下圆角边框与页脚依然完整。 */
class SelectBody extends DialogBody {
	/** 上一次渲染时列表在正文里的起始行与高度，鼠标事件按它换算坐标。 */
	private listTop = 0;
	private listRows = 0;

	constructor(
		private readonly list: SelectList,
		private readonly text: Text | undefined,
		budget: () => number,
		private readonly hint: string,
	) {
		super(budget);
	}

	private textLines(width: number): string[] {
		return this.text ? this.text.render(width) : [];
	}

	protected override minContentRows(): number {
		// 列表至少要能露出几行才算可用；正文（提示文字）再挤占剩下的行。
		return Math.min(this.list.itemCount, LIST_RESERVE_ROWS);
	}

	protected override footerText(): string {
		return this.hint;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return this.list.handleMouse?.({ ...event, y: event.y - this.listTop, height: this.listRows });
	}

	protected override renderContent(width: number, rows: number, leadingRows: number): string[] {
		const textLines = this.textLines(width);
		const maxTextRows = Math.max(0, rows - Math.min(this.list.itemCount, LIST_RESERVE_ROWS));
		const visibleText =
			textLines.length > maxTextRows
				? [...textLines.slice(0, Math.max(0, maxTextRows - 1)), truncateToWidth(theme.fg('dim', ' …'), width, '')]
				: textLines;
		// 列表自身溢出时还会多渲染一行 `(n/m)` 滚动提示,得把它算进可见行数。
		const available = Math.max(1, rows - visibleText.length);
		const overflow = this.list.itemCount > available;
		this.list.setMaxVisible(overflow ? Math.max(1, available - 1) : available);
		const listLines = this.list.render(width);
		this.listTop = leadingRows + visibleText.length;
		this.listRows = listLines.length;
		return [...visibleText, ...listLines];
	}
}

/** 单行输入正文。 */
class InputBody extends DialogBody {
	constructor(
		private readonly input: Input,
		budget: () => number,
		private readonly hint: string,
	) {
		super(budget);
	}

	protected override minContentRows(): number {
		return 1;
	}

	protected override footerText(): string {
		return this.hint;
	}

	protected override renderContent(width: number): string[] {
		return this.input.render(width);
	}
}

/** 带标题与底边框状态文本的对话框外壳;外壳由圆角边框盒绘制。 */
class DialogShell extends Container {
	protected readonly box: RoundedDialogBox;
	private bottomInfo: () => string = () => '';
	private closeHandler: () => void = () => {};

	protected constructor(title: string) {
		super();
		this.box = new RoundedDialogBox(title, () => this.bottomInfo());
		this.addChild(this.box);
	}

	protected addBody(component: Component): void {
		this.box.addChild(component);
	}

	/** 设置底边框右侧的状态文本（在子组件渲染之后取值）。 */
	protected setBottomInfo(provider: () => string): void {
		this.bottomInfo = provider;
	}

	setCloseHandler(handler: () => void): void {
		this.closeHandler = handler;
	}

	close(): void {
		this.closeHandler();
	}
}

class SelectDialog extends DialogShell {
	private readonly list: SelectList;

	constructor(
		title: string,
		items: SelectItem[],
		maxVisible: number,
		hint: string,
		bodyText: string | undefined,
		budget: () => number,
	) {
		super(title);
		this.list = new SelectList(items, maxVisible, getSelectListTheme());
		const text = bodyText ? new Text(theme.fg('muted', ` ${bodyText}`), 0, 0) : undefined;
		this.addBody(new SelectBody(this.list, text, budget, hint));
	}

	onSelect(handler: (item: SelectItem) => void): void {
		this.list.onSelect = handler;
	}

	onCancel(handler: () => void): void {
		this.list.onCancel = handler;
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}
}

class InputDialog extends DialogShell {
	private readonly input: Input;

	constructor(title: string, initialValue: string, hint: string, budget: () => number) {
		super(title);
		this.input = new Input();
		this.input.setValue(initialValue);
		this.addBody(new InputBody(this.input, budget, hint));
	}

	onSubmit(handler: (value: string) => void): void {
		this.input.onSubmit = handler;
	}

	handleInput(data: string): void {
		if (matchesKey(data, 'escape')) {
			this.close();
			return;
		}
		this.input.handleInput(data);
	}
}

class MessageDialog extends DialogShell {
	private readonly body: ScrollableTextBody;

	constructor(title: string, text: string, hint: string, budget: () => number) {
		super(title);
		this.body = new ScrollableTextBody(text, budget, hint);
		this.setBottomInfo(() => this.body.getScrollInfo());
		this.addBody(this.body);
	}

	handleInput(data: string): void {
		if (matchesKey(data, 'escape') || matchesKey(data, 'enter') || matchesKey(data, 'ctrl+c')) {
			this.close();
			return;
		}
		if (matchesKey(data, 'up')) this.body.scrollBy(-1);
		else if (matchesKey(data, 'down')) this.body.scrollBy(1);
		else if (matchesKey(data, 'pageUp')) this.body.scrollByPage(-1);
		else if (matchesKey(data, 'pageDown')) this.body.scrollByPage(1);
		else if (matchesKey(data, 'home')) this.body.scrollToStart();
		else if (matchesKey(data, 'end')) this.body.scrollToEnd();
	}
}

/**
 * 一次性收尾：隐藏浮层并 resolve，只生效一次。
 * Esc / Enter / 点选可能重复触发关闭，重复调用必须被吞掉。
 */
function settleOnce<T>(handle: OverlayHandle, resolve: (value: T) => void): (value: T) => void {
	let settled = false;
	return (value: T) => {
		if (settled) return;
		settled = true;
		handle.hide();
		resolve(value);
	};
}

function overlayOptions(
	width: SizeValue,
	maxHeight: SizeValue,
): { width: SizeValue; maxHeight: SizeValue; anchor: 'center'; margin: number } {
	return { width, maxHeight, anchor: 'center', margin: 1 };
}

/** 选择列表对话框；返回选中项的 value，取消返回 undefined。 */
export function showSelectDialog(
	tui: TUI,
	options: {
		title: string;
		items: SelectItem[];
		maxVisible?: number;
		hint?: string;
		bodyText?: string;
		width?: SizeValue;
		maxHeight?: SizeValue;
	},
): Promise<string | undefined> {
	return new Promise((resolve) => {
		const maxHeight = options.maxHeight ?? '70%';
		const dialog = new SelectDialog(
			options.title,
			options.items,
			options.maxVisible ?? 10,
			options.hint ?? DEFAULT_HINT,
			options.bodyText,
			() => rowBudget(tui, maxHeight),
		);
		const handle = tui.showOverlay(dialog, overlayOptions(options.width ?? '80%', maxHeight));
		const finish = settleOnce(handle, resolve);
		dialog.onSelect((item) => finish(item.value));
		dialog.onCancel(() => finish(undefined));
	});
}

/** 单行输入对话框；返回输入值，取消返回 undefined。 */
export function showInputDialog(
	tui: TUI,
	options: { title: string; initialValue?: string; hint?: string; width?: SizeValue; maxHeight?: SizeValue },
): Promise<string | undefined> {
	return new Promise((resolve) => {
		const maxHeight = options.maxHeight ?? '40%';
		const dialog = new InputDialog(
			options.title,
			options.initialValue ?? '',
			options.hint ?? 'Enter confirm · Esc cancel',
			() => rowBudget(tui, maxHeight),
		);
		const handle = tui.showOverlay(dialog, overlayOptions(options.width ?? '70%', maxHeight));
		const finish = settleOnce(handle, resolve);
		dialog.onSubmit((value) => finish(value));
		dialog.setCloseHandler(() => finish(undefined));
	});
}

/** 确认对话框；返回是否确认。 */
export async function showConfirmDialog(
	tui: TUI,
	options: { title: string; message: string; confirmLabel?: string; cancelLabel?: string },
): Promise<boolean> {
	const items: SelectItem[] = [
		{ value: 'confirm', label: options.confirmLabel ?? 'Confirm' },
		{ value: 'cancel', label: options.cancelLabel ?? 'Cancel' },
	];
	const selected = await showSelectDialog(tui, {
		title: options.title,
		bodyText: options.message,
		items,
		maxVisible: 2,
	});
	return selected === 'confirm';
}

/** 只读长文本对话框（帮助、状态、待办、任务等）。 */
export function showMessageDialog(
	tui: TUI,
	options: { title: string; text: string; hint?: string; width?: SizeValue; maxHeight?: SizeValue },
): Promise<void> {
	return new Promise((resolve) => {
		const maxHeight = options.maxHeight ?? '75%';
		const dialog = new MessageDialog(
			options.title,
			options.text,
			options.hint ?? 'Esc close',
			() => rowBudget(tui, maxHeight),
		);
		const handle = tui.showOverlay(dialog, overlayOptions(options.width ?? '86%', maxHeight));
		const finish = settleOnce<void>(handle, resolve);
		dialog.setCloseHandler(() => finish());
	});
}
