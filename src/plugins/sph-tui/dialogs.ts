/**
 * 基于浮层的对话框：选择列表、文本输入、确认、只读长文本。
 *
 * 选择、输入、确认共用一个圆角外壳：浮层自动获得焦点，Esc 取消，Enter 确认，关闭即隐藏。
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
	type TuiMouseEvent,
	type TuiMouseEventResult,
	type OverlayHandle,
	type SizeValue,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from '@/tui/index.js';
import { extractAnsiCode, renderRoundedBox } from '@/tui/text/utils.js';
import { getMarkdownTheme, getSelectListTheme, theme } from '@/plugins/sph-tui/theme/theme.js';

/**
 * 给对话框整行铺上浮层面色（报告弹窗与四类弹窗共用同一套铺底规则，见 report/dialog.ts）。
 *
 * 画布（#141414）不铺底的浮层只有一圈边框，里面跟背景一个色；正文在两列留白处被切断后，
 * 整块看起来像「抠掉一块、露出黑底」——用户报的「弹窗有黑色背景」就是这个。
 *
 * 底色要挂在每个 SGR 之后重申：行内任何 `0m`（全重置）都会把底色一起清掉，
 * 行尾必须回到 49m（画布/终端默认底），否则底色会渗到下一行。
 */
export function fillDialogSurface(line: string, width: number, surface: string): string {
	const padded = line + ' '.repeat(Math.max(0, width - visibleWidth(line)));
	let out = surface;
	let index = 0;
	while (index < padded.length) {
		const ansi = extractAnsiCode(padded, index);
		if (ansi) {
			out += ansi.code;
			if (ansi.code.endsWith('m')) out += surface;
			index += ansi.length;
			continue;
		}
		out += padded[index]!;
		index += 1;
	}
	return `${out}\x1b[49m`;
}

const DEFAULT_HINT = '↑↓ select · Enter confirm · Esc cancel';
const SCROLL_HINT = '↑↓ scroll · PgDn page';
const SELECT_SCROLL_HINT = '↑↓ scroll · Tab select · Enter confirm · Esc cancel';
/** 正文挤占列表行数时，列表至少要留下的可见行数。 */
const LIST_RESERVE_ROWS = 3;

/** 浮层高度预算（行）：与 overlayOptions 里的 maxHeight 同源，每帧按终端尺寸重算。报告弹窗（report/dialog.ts）与四类弹窗共用同一份算法——预算和浮层选项各算各的就会互相打架。 */
export function rowBudget(tui: TUI, maxHeight: SizeValue): number {
	const rows = Math.max(1, tui.terminal.rows);
	const available = Math.max(1, rows - 2); // overlayOptions 固定 margin: 1
	const wanted =
		typeof maxHeight === 'number' ? maxHeight : Math.floor((rows * Number.parseFloat(maxHeight)) / 100);
	return Math.max(1, Math.min(Number.isFinite(wanted) ? wanted : available, available));
}

/** 弹窗内容与边框之间留的白（列）。贴着边框排正文是「文字要溢出盒子」观感的主要来源。 */
const PAD_X = 2;

/**
 * 弹窗的圆角边框盒:顶部边框嵌标题,内部竖排子组件,每行包上侧边框。
 * 边框仍是 borderMuted 灰；标题单独用主色加粗，避免标题和装饰混成一块灰。
 */
class RoundedDialogBox extends Container {
	private readonly label: string;
	/** 底边框右侧的状态文本（如滚动位置）。子组件渲染完才取值，所以拿到的是本帧状态。 */
	private readonly bottomInfo: () => string;
	/**
	 * 底边框左侧的操作提示。参数是提示能用的列数（已扣右侧读数）——
	 * 提示方据此切紧凑档，省略号只做最后兜底。
	 */
	private leftInfo: (budget: number) => string = () => '';
	/** 高度预算的硬封顶（与浮层 maxHeight 同源）。 */
	private readonly maxRows?: () => number;
	/** 为 true 时铺画布底（与终端同色），不铺浮层面 dialogBg。 */
	private readonly transparent: boolean;
	/** 上一次渲染的外框宽度与内部行数：鼠标事件要换算到子组件的坐标空间（见 handleMouse）。 */
	private boxWidth = 0;
	private interiorRows = 0;

	constructor(title: string, bottomInfo: () => string = () => '', maxRows?: () => number, transparent = false) {
		super();
		this.label = ` ${title} `;
		this.bottomInfo = bottomInfo;
		this.maxRows = maxRows;
		this.transparent = transparent;
	}

	/** 设置底边框左侧的操作提示；在子组件渲染之后取值。 */
	setLeftInfo(provider: (budget: number) => string): void {
		this.leftInfo = provider;
	}

	/** 子组件（正文）能用的宽度：扣掉左右边框与两侧留白。 */
	private interiorWidth(): number {
		return Math.max(1, Math.max(1, this.boxWidth - 2) - PAD_X * 2);
	}

	override render(width: number): string[] {
		this.boxWidth = width;
		// 浮层对超限内容只会整块从底部裁掉——底边框、页脚和最后几条选项会一起消失
		// （见 compositeOverlays 的 slice）。所以内部行数在这里按同一份预算封顶：
		// 宁可挤掉中间的行，标题、页脚和底边框必须保住。
		let lines = super.render(this.interiorWidth());
		const cap = this.maxRows?.();
		const maxInterior = cap === undefined ? Number.POSITIVE_INFINITY : Math.max(1, cap - 2);
		if (lines.length > maxInterior) {
			lines =
				maxInterior >= 2
					? [...lines.slice(0, maxInterior - 1), lines[lines.length - 1]!]
					: [lines[lines.length - 1]!];
		}
		// 内边距在这里统一施加一次：正文、列表、输入框都不必各自缩进。
		lines = lines.map((line) => `${' '.repeat(PAD_X)}${line}`);
		this.interiorRows = lines.length;
		// 底边框在子组件渲染之后才拼,滚动位置之类的信息才是本帧的(与补全菜单盒同款)。
		const info = this.bottomInfo();
		// 左侧提示的列预算 = 整盒宽 - 框件与空格(8) - 右侧读数(含两侧垫的空格)。
		// 与 renderRoundedBox 内部的截断预算同源，提示方按它切紧凑档才不会两头打架。
		const infoBudget = Math.max(0, width - 8 - (info === '' ? 0 : visibleWidth(info) + 2));
		const boxed = renderRoundedBox({
			width,
			title: this.label,
			lines,
			bottomInfo: info,
			leftInfo: this.leftInfo(infoBudget),
			leftInfoPaint: (text) => theme.fg('dim', text),
			frame: (text) => theme.fg('borderMuted', text),
			titlePaint: (text) => theme.bold(theme.fg('primary', text)),
		});
		// 透空档铺画布底（truecolor 下即 OSC 11 的 #141414，ansi 下是终端默认 49m），
		// 空格仍盖住底下的页眉/转录；不打穿，否则标题栏空格会把「Skills」拆开。
		const surface = theme.bgSeq(this.transparent ? 'bg' : 'dialogBg');
		return boxed.map((row) => fillDialogSurface(row, width, surface));
	}

	override handleMouse(event: TuiMouseEvent) {
		// 子组件从第 2 行开始（第 1 行是上边框），鼠标坐标要跟着下移一行；
		// 内容又因内边距右移了 PAD_X 列，x 也要把边框和留白一起扣掉。
		//
		// **宽高也必须一起换算**：容器会拿 `mouseLayout.width` 与事件宽度比，不等就重新渲染
		// 子组件去量高度。那趟测量用的宽度是外层宽度（多出边框与留白），行数算多了，而滚动视口
		// 会在渲染里写回 contentHeight / 夹住 offset——于是滚轮滚到一半再也下不去（键盘不经过
		// 这里，所以没事）。换算到子组件的坐标空间，容器就直接复用渲染时的布局，不再重渲。
		return super.handleMouse({
			...event,
			x: event.x - 1 - PAD_X,
			y: event.y - 1,
			width: this.interiorWidth(),
			height: this.interiorRows,
		});
	}
}

/**
 * 弹窗正文：把内容排进行预算。
 *
 * 操作提示不占内容行——它由外壳挪到底边框左侧（footerText），内容行数可以全用在
 * 正文上。顶部与底部各留一行空白，与盒子左右各 2 列的 PAD_X 合成四边内边距；
 * 底边框上不再贴着最后一行内容。
 *
 * 子类给出「最少要几行内容」和「按分到的行数渲染内容」——前者决定留白的取舍，
 * 后者让滚动视口、列表这类需要提前知道行数的内容自己分配。
 */
abstract class DialogBody implements Component {
	protected constructor(private readonly budget: () => number) {}

	/** 内容至少要占的行数。 */
	protected abstract minContentRows(width: number): number;

	/** 按分到的行数渲染内容；`leadingRows` 是内容之前已占用的行数（顶部留白），鼠标坐标要加回来。 */
	protected abstract renderContent(width: number, rows: number, leadingRows: number): string[];

	/**
	 * 底边框左侧的操作提示。`budget` 是提示能用的列数（外壳按右侧读数扣除后给出）：
	 * 超了就切紧凑档（只留键名），而不是让省略号从尾部把 Esc 吃掉。空串表示不显示。
	 */
	abstract footerText(budget?: number): string;

	/** 本帧内容是否溢出视口：页脚据此选完整滚动提示还是短句（与内边距无关）。 */
	protected scrollableNow = false;

	invalidate(): void {}

	render(width: number): string[] {
		// 预算是上限不是目标高度。短内容按行数收，避免 /help 这类弹窗被撑成一块固定窗口。
		const maxBody = Math.max(1, this.budget() - 2);
		// 四边内边距恒定：上下各一行空白、左右各两列（PAD_X 在外壳统一施加）——
		// 可滚动的弹窗也不例外，内容贴着底边框会显得框「漏了底」。
		const lines = ['', ...this.renderContent(width, Math.max(1, maxBody - 2), 1), ''];
		return lines.length > maxBody ? lines.slice(0, maxBody) : lines;
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

	constructor(text: string, budget: () => number, hint: string, termColumns = false) {
		super(budget);
		// 内边距由 RoundedDialogBox 统一施加，这里不再自带缩进。
		this.markdown = new Markdown(text, 0, 0, getMarkdownTheme(), {
			color: (content: string) => theme.fg('mdText', content),
		}, {
			// 报告条目（`- \`term\` — desc`）排成词项列。**由调用方点名开**：计划复核那种
			// 模型自己写的正文里，`—` 是作者的标点，替它吃掉就是改用户内容。
			termColumnLists: termColumns,
		});
		this.hint = hint;
	}

	/** 底边框右格的位置读数 `18-24/60`；内容装得下时为空。 */
	getScrollInfo(): string {
		if (this.contentHeight <= this.viewportHeight) return '';
		return `${this.offset + 1}-${this.offset + this.viewportHeight}/${this.contentHeight}`;
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

	override footerText(budget?: number): string {
		const full = this.scrollableNow ? `${SCROLL_HINT} · ${this.hint}` : this.hint;
		if (budget === undefined || visibleWidth(full) <= budget) return full;
		// 可滚时 PgDn 让位（↑↓ 能到的地方多按几下就到）；窄档只保 Esc——关不掉的弹窗比
		// 没有提示更糟。报告弹窗的按键提示由 action 声明按 dropPriority 裁剪，不走这里。
		return this.scrollableNow ? '↑↓ · Esc' : 'Esc';
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
		this.scrollableNow = this.scrollable;
		return content.slice(this.offset, this.offset + this.viewportHeight);
	}
}

/** 正文渲染方式。`plain` 原样保留文本——命令、路径这类内容过 Markdown 会被转义改写。 */
export type DialogBodyFormat = 'markdown' | 'plain';

/** 选择列表正文：把列表可见行数压进预算，矮终端下圆角边框与页脚依然完整。 */
class SelectBody extends DialogBody {
	/** 上一次渲染时列表在正文里的起始行与高度，鼠标事件按它换算坐标。 */
	private listTop = 0;
	private listRows = 0;
	private readonly markdown: Markdown | undefined;
	private readonly plainText: string | undefined;
	private offset = 0;
	private textHeight = 0;
	private textViewport = 0;

	constructor(
		private readonly list: SelectList,
		bodyText: string | undefined,
		budget: () => number,
		private readonly hint: string,
		format: DialogBodyFormat = 'markdown',
		termColumns = false,
	) {
		super(budget);
		this.plainText = format === 'plain' ? bodyText : undefined;
		this.markdown =
			bodyText && format === 'markdown'
				? new Markdown(bodyText, 0, 0, getMarkdownTheme(), {
						color: (content: string) => theme.fg('mdText', content),
					}, { termColumnLists: termColumns })
				: undefined;
	}

	/**
	 * 列表优先于正文：光标在列表上，「第几项 / 共几项」才是用户当下要的信息；
	 * 正文区间只在正文真的溢出、且列表不溢出时才报。
	 */
	getScrollInfo(): string {
		const listInfo = this.list.getScrollInfo();
		if (listInfo !== '') return listInfo;
		if (this.textHeight <= this.textViewport) return '';
		return `${this.offset + 1}-${this.offset + this.textViewport}/${this.textHeight}`;
	}

	get scrollable(): boolean {
		return this.textHeight > this.textViewport;
	}

	scrollBy(lines: number): void {
		const max = Math.max(0, this.textHeight - this.textViewport);
		this.offset = Math.max(0, Math.min(max, this.offset + lines));
	}

	scrollByPage(direction: -1 | 1): void {
		this.scrollBy(direction * Math.max(1, this.textViewport - 1));
	}

	scrollToStart(): void {
		this.offset = 0;
	}

	scrollToEnd(): void {
		this.offset = Math.max(0, this.textHeight - this.textViewport);
	}

	/** 正文可滚时方向键滚正文；Tab 切选项。返回 true 表示已消费。 */
	handleNav(data: string): boolean {
		if (matchesKey(data, 'tab')) {
			this.list.cycle(1);
			return true;
		}
		if (matchesKey(data, 'shift+tab')) {
			this.list.cycle(-1);
			return true;
		}
		if (!this.scrollable) return false;
		if (matchesKey(data, 'up')) {
			this.scrollBy(-1);
			return true;
		}
		if (matchesKey(data, 'down')) {
			this.scrollBy(1);
			return true;
		}
		if (matchesKey(data, 'pageUp')) {
			this.scrollByPage(-1);
			return true;
		}
		if (matchesKey(data, 'pageDown')) {
			this.scrollByPage(1);
			return true;
		}
		if (matchesKey(data, 'home')) {
			this.scrollToStart();
			return true;
		}
		if (matchesKey(data, 'end')) {
			this.scrollToEnd();
			return true;
		}
		return false;
	}

	protected override minContentRows(): number {
		// 列表至少要能露出几行才算可用；正文再挤占剩下的行。
		return Math.min(this.list.itemCount, LIST_RESERVE_ROWS);
	}

	override footerText(budget?: number): string {
		const full = this.scrollableNow ? SELECT_SCROLL_HINT : this.hint;
		if (budget === undefined || visibleWidth(full) <= budget) return full;
		// 窄档只保选择框真正的三件事：翻、选、退。Esc 压轴。
		return this.scrollableNow ? '↑↓ · Tab · Enter · Esc' : '↑↓ · Enter · Esc';
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === 'wheel' && event.wheelDelta && event.y < this.listTop) {
			this.scrollBy(event.wheelDelta);
			return { handled: true, render: true };
		}
		return this.list.handleMouse?.({ ...event, y: event.y - this.listTop, height: this.listRows });
	}

	protected override renderContent(width: number, rows: number, leadingRows: number): string[] {
		const textLines = this.renderBodyLines(width);
		this.textHeight = textLines.length;
		const listReserve = Math.min(this.list.itemCount, LIST_RESERVE_ROWS);
		const maxTextRows = Math.max(0, rows - listReserve);
		this.textViewport = Math.min(maxTextRows, Math.max(0, textLines.length));
		this.offset = Math.max(0, Math.min(this.offset, Math.max(0, textLines.length - this.textViewport)));
		this.scrollableNow = this.scrollable;
		const visibleText = textLines.slice(this.offset, this.offset + this.textViewport);
		// 正文与选项之间加一条淡分隔：不然「说明」和「可选项」糊成一片，用户分不清哪几行能选。
		// 分隔行也要占预算（下面把它从列表可用行里扣掉），否则总行数会顶穿 DialogBody 的裁剪，
		// 最后一条选项被切掉。
		const dividerRows = visibleText.length > 0 && this.list.itemCount > 0 ? 1 : 0;
		const available = Math.max(1, rows - visibleText.length - dividerRows);
		// 列表不再自带 `(n/m)` 行（见 SelectDialog 里 renderScrollInfoLine=false），
		// 所以这里不用给它留一行，底边框的状态位负责报位置。
		this.list.setMaxVisible(available);
		const listLines = this.list.render(width);
		const divider = dividerRows === 1 && listLines.length > 0
			? [theme.fg('borderMuted', '─'.repeat(Math.max(1, width)))]
			: [];
		this.listTop = leadingRows + visibleText.length + divider.length;
		this.listRows = listLines.length;
		return [...visibleText, ...divider, ...listLines];
	}
	/** 正文行：plain 逐字保留（只做按宽换行），markdown 走渲染器。内边距由外壳统一施加。 */
	private renderBodyLines(width: number): string[] {
		if (this.markdown) return this.markdown.render(width);
		if (this.plainText === undefined) return [];
		return wrapTextWithAnsi(this.plainText, Math.max(1, width)).map((line) => theme.fg('mdText', line));
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

	override footerText(budget?: number): string {
		if (budget === undefined || visibleWidth(this.hint) <= budget) return this.hint;
		// 输入框的提示有的是纯说明（没有键位段），窄档下统一保真正的两个键：确认与退出。
		return 'Enter · Esc';
	}

	protected override renderContent(width: number): string[] {
		return this.input.render(width);
	}
}

/** 带标题与底边框状态文本的对话框外壳;外壳由圆角边框盒绘制。 */
class DialogShell extends Container {
	protected readonly box: RoundedDialogBox;
	private bottomInfo: () => string = () => '';
	/** 正文（若已挂载）；底边框左侧的操作提示从它取。 */
	private mainBody: DialogBody | undefined;
	private closeHandler: () => void = () => {};

	protected constructor(title: string, maxRows?: () => number, transparent = false) {
		super();
		this.box = new RoundedDialogBox(title, () => this.bottomInfo(), maxRows, transparent);
		// 操作提示放底边框左侧：同一行既说明怎么操作、又报当前位置，不再各占一行。
		// 列预算透传给正文——放不下时由它切紧凑档，Esc 不会被省略号从尾巴上吃掉。
		this.box.setLeftInfo((budget) => this.mainBody?.footerText(budget) ?? '');
		this.addChild(this.box);
	}

	protected addBody(component: Component): void {
		this.box.addChild(component);
		if (component instanceof DialogBody) this.mainBody = component;
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
	private readonly body: SelectBody;

	constructor(
		options: {
			title: string;
			items: SelectItem[];
			maxVisible: number;
			hint: string;
			bodyText: string | undefined;
			format: DialogBodyFormat;
			transparent: boolean;
			numbered: boolean;
			termColumns: boolean;
		},
		budget: () => number,
	) {
		super(options.title, budget, options.transparent);
		this.list = new SelectList(options.items, options.maxVisible, getSelectListTheme(), {
			numbered: options.numbered,
		});
		// 列表内部的 `(n/m)` 行关掉，改用底边框右侧的状态位——与文档弹窗、内联菜单同一处，
		// 顺带把那一行还给选项（弹窗里的行预算本来就紧）。
		this.list.renderScrollInfoLine = false;
		this.body = new SelectBody(this.list, options.bodyText, budget, options.hint, options.format, options.termColumns);
		this.setBottomInfo(() => this.body.getScrollInfo());
		this.addBody(this.body);
	}

	onSelect(handler: (item: SelectItem) => void): void {
		this.list.onSelect = handler;
	}

	onCancel(handler: () => void): void {
		this.list.onCancel = handler;
	}

	/** 初始焦点（危险确认用）：停在安全项，Enter 连按不会误删。 */
	focusIndex(index: number): void {
		this.list.setInitialIndex(index);
	}

	handleInput(data: string): void {
		if (this.body.handleNav(data)) return;
		this.list.handleInput(data);
	}
}

class InputDialog extends DialogShell {
	private readonly input: Input;

	constructor(title: string, initialValue: string, hint: string, budget: () => number) {
		super(title, budget);
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

	constructor(
		title: string,
		text: string,
		hint: string,
		budget: () => number,
		transparent = false,
		termColumns = false,
	) {
		super(title, budget, transparent);
		this.body = new ScrollableTextBody(text, budget, hint, termColumns);
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

/**
 * 弹窗版式档位。一处定义，所有弹窗按用途取——调用方仍可显式覆盖 maxHeight。
 *
 * 分档之前所有弹窗共用 72% / 上限 84 / 60% 高：宽度对两三项的确认框太宽（右侧一大片
 * 空白），高度对 60+ 行的 `/help` 太矮（要翻四屏）。两头毛病是同一刀切出来的。
 *
 * 宽度分百分比与上限两部分：百分比让窄终端胜出，上限让宽终端不至于把弹窗拉成整屏
 * （终端 147 列时 72% 的 105 列收到 84 列），否则正文行长失控、标题与选项左右拉散。
 */
export type DialogKind = 'confirm' | 'select' | 'input' | 'document';

const DIALOG_LAYOUTS: Record<DialogKind, { width: SizeValue; maxWidth: number; maxHeight: SizeValue }> = {
	/** 是/否这类两三项：窄一点，别让一句话占满整屏。 */
	confirm: { width: '52%', maxWidth: 56, maxHeight: '40%' },
	/** 带正文的选项框：正文要读，选项要够宽。 */
	select: { width: '72%', maxWidth: 84, maxHeight: '60%' },
	/** 单行输入：最窄的一档。 */
	input: { width: '64%', maxWidth: 72, maxHeight: '30%' },
	/** 只读长文本（/help、上报、diff）：高度优先，翻屏次数直接决定好不好用。 */
	document: { width: '88%', maxWidth: 100, maxHeight: '88%' },
};

export const APPROVAL_OVERLAY_PRIORITY = 100;

/** 解析实际高度：显式覆盖优先。行预算与浮层选项必须用同一个值，否则互相打架。 */
function maxHeightFor(kind: DialogKind, override?: SizeValue): SizeValue {
	return override ?? DIALOG_LAYOUTS[kind].maxHeight;
}

function overlayOptions(
	kind: DialogKind,
	maxHeight: SizeValue,
	priority = 0,
	width?: SizeValue,
	maxWidth?: number,
	row?: SizeValue,
): {
	width: SizeValue;
	maxHeight: SizeValue;
	maxWidth: number;
	priority: number;
	margin: number;
	padX: number;
} & ({ anchor: 'center'; row?: undefined } | { row: SizeValue; anchor?: undefined }) {
	const layout = DIALOG_LAYOUTS[kind];
	const base = {
		// width 原先是个死选项：签名里有、没往下传，调用方传了也不生效。
		width: width ?? layout.width,
		maxHeight,
		maxWidth: maxWidth ?? layout.maxWidth,
		priority,
		margin: 1,
		// 弹窗两侧各留两列空白：浮层只盖自己的列区间，不留白的话底稿文字会直接
		// 贴着边框，看起来像穿透了弹窗。
		padX: 2,
	};
	// 垂直定位二者只给其一：row 是「就地展开」的绝对落点，anchor 是屏幕居中。
	// 同时给的时候 tui 以 row 为准，anchor 成了骗人的死配置——类型上直接表达成不可能。
	return row === undefined ? { ...base, anchor: 'center' as const } : { ...base, row };
}

/**
 * 命令面板共用的浮层版式：六成宽、占屏高四分之三、顶边距屏幕 10%，框内铺画布底（与终端同色）
 * 而不是浮层面。`/skills`、`/plugins`、`/help` 这些读信息的框，与 `/resume`、`/history`
 * 这些列表框都用它——都是「敲个命令就地展开的一层」，不该一个宽一个窄、来回换底色。
 *
 * 审批框与确认框**不要**用它：那两类是「先答话才能继续」，必须压过正文、抢到注意力，
 * 所以继续走各自的窄档与浮层面色。
 */
export function commandPanelOptions(tui: TUI): {
	width: SizeValue;
	maxWidth: number;
	maxHeight: SizeValue;
	row: SizeValue;
	transparent: boolean;
} {
	return {
		width: '60%',
		// 百分比宽度在宽终端上要有个软上限：200 列终端的 60% 是 132 列，正文行长
		// 超出舒适阅读区间。120 列封顶，窄终端的百分比照旧生效。
		maxWidth: 120,
		maxHeight: '75%',
		// OverlayOptions.row 的百分比是剩余空白里的比例，不是距顶部。这里按终端行数取 10%。
		row: Math.max(0, Math.floor(tui.terminal.rows * 0.1)),
		transparent: true,
	};
}

/**
 * 无正文短菜单的宽度钳制：盒宽随内容收，不铺满档位百分比——三四个短选项配 72% 宽，
 * 右侧一大片空白。有正文的弹窗宽度服务正文，不钳；档位上限仍是天花板。
 */
function contentClampedMaxWidth(
	maxWidth: number | undefined,
	items: readonly SelectItem[],
	title: string,
	hasBody: boolean,
): number | undefined {
	if (hasBody || items.length === 0) return maxWidth;
	const maxLabel = Math.max(...items.map((item) => visibleWidth(item.label || item.value)));
	const maxTrailing = Math.max(
		0,
		...items.map((item) => (item.trailing === undefined ? 0 : visibleWidth(item.trailing) + 2)),
	);
	// 26 = 标记与号槽(2) + 两侧内边距(4) + 边框(2) + 说明列的呼吸位；尾列另计（右对齐整列）。
	const want = Math.max(maxLabel + maxTrailing + 26, visibleWidth(title) + 10);
	return Math.min(maxWidth ?? Number.POSITIVE_INFINITY, want);
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
		/** 正文渲染方式；含命令、路径等需要逐字展示的内容时用 plain。 */
		bodyFormat?: DialogBodyFormat;
		/** 更高优先级的弹窗会压过普通面板并保留键盘焦点。 */
		priority?: number;
		/** 版式档位；确认这类两三项的窄框传 confirm。 */
		kind?: DialogKind;
		width?: SizeValue;
		/** 覆盖本档列上限；百分比宽度在宽终端上会被 maxWidth 夹住，要放开得一起给。 */
		maxWidth?: number;
		maxHeight?: SizeValue;
		/** 距浮动区顶部的行数（百分比是剩余空白里的比例，不是屏高比例）。 */
		row?: SizeValue;
		/** 铺画布底（与终端同色），不铺浮层面 dialogBg。审批、确认框不要开。 */
		transparent?: boolean;
			/** 行号槽：条目名字不可称呼时（会话 id、历史 prompt）才开。 */
			numbered?: boolean;
			/** 正文里的 `- \`term\` — desc` 排成词项列。只读报告开，模型写的正文别开。 */
			termColumns?: boolean;
			/** 初始焦点行；危险确认把它停在安全项上，Enter 连按不会误删。 */
			initialIndex?: number;
		},
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			const kind = options.kind ?? 'select';
			const maxHeight = maxHeightFor(kind, options.maxHeight);
			const dialog = new SelectDialog(
				{
					title: options.title,
					items: options.items,
					maxVisible: options.maxVisible ?? 10,
					hint: options.hint ?? DEFAULT_HINT,
					bodyText: options.bodyText,
					format: options.bodyFormat ?? 'markdown',
					transparent: options.transparent === true,
					numbered: options.numbered === true,
					termColumns: options.termColumns === true,
				},
				() => rowBudget(tui, maxHeight),
			);
			if (options.initialIndex !== undefined) dialog.focusIndex(options.initialIndex);
			const maxWidth = contentClampedMaxWidth(
				options.maxWidth ?? DIALOG_LAYOUTS[kind].maxWidth,
				options.items,
				options.title,
				options.bodyText !== undefined,
			);
			const overlay = overlayOptions(kind, maxHeight, options.priority, options.width, maxWidth);
		if (options.row !== undefined) overlay.row = options.row;
		const handle = tui.showOverlay(dialog, overlay);
		const finish = settleOnce(handle, resolve);
		dialog.onSelect((item) => finish(item.value));
		dialog.onCancel(() => finish(undefined));
	});
}

/** 单行输入对话框；返回输入值，取消返回 undefined。宽度随内容收，短值不再配大框。 */
export function showInputDialog(
	tui: TUI,
	options: { title: string; initialValue?: string; hint?: string; width?: SizeValue; maxWidth?: number; maxHeight?: SizeValue; priority?: number },
): Promise<string | undefined> {
	return new Promise((resolve) => {
		const maxHeight = maxHeightFor('input', options.maxHeight);
		// 短值配窄框：初始值（或占位它应有的呼吸位）+ 标题，三者取大，档位上限封顶。
		const want = Math.max(
			visibleWidth(options.initialValue ?? '') + 24,
			visibleWidth(options.title) + 10,
			40,
		);
		const maxWidth = Math.min(options.maxWidth ?? DIALOG_LAYOUTS.input.maxWidth, want);
		const dialog = new InputDialog(
			options.title,
			options.initialValue ?? '',
			options.hint ?? 'Enter confirm · Esc cancel',
			() => rowBudget(tui, maxHeight),
		);
		const handle = tui.showOverlay(dialog, overlayOptions('input', maxHeight, options.priority, options.width, maxWidth));
		const finish = settleOnce(handle, resolve);
		dialog.onSubmit((value) => finish(value));
		dialog.setCloseHandler(() => finish(undefined));
	});
}

/**
 * 确认对话框；返回是否确认。
 *
 * `danger: true` 是破坏性确认：确认项标红、焦点初始停在安全项上——Enter 连按不会误删，
 * 破坏性动作必须多按一次 ↓ 才够得着。后果句请由调用方用 `!!…!!` 标记上警示色。
 */
export async function showConfirmDialog(
	tui: TUI,
	options: { title: string; message: string; confirmLabel?: string; cancelLabel?: string; priority?: number; danger?: boolean },
): Promise<boolean> {
	const danger = options.danger === true;
	const items: SelectItem[] = danger
		? [
				{ value: 'cancel', label: options.cancelLabel ?? 'Cancel' },
				{ value: 'confirm', label: options.confirmLabel ?? 'Confirm', tone: 'danger' },
			]
		: [
				{ value: 'confirm', label: options.confirmLabel ?? 'Confirm' },
				{ value: 'cancel', label: options.cancelLabel ?? 'Cancel' },
			];
	const selected = await showSelectDialog(tui, {
		title: options.title,
		bodyText: options.message,
		items,
		maxVisible: 2,
		kind: 'confirm',
		priority: options.priority,
		initialIndex: 0,
	});
	return selected === 'confirm';
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** 加载正文：转轮 + 文本 + 右对齐秒表。等待超过几秒时，「画面还在动」比任何文案都重要。 */
class LoadingBody extends DialogBody {
	private frame = 0;
	private readonly startedAt = Date.now();
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly text: string,
		budget: () => number,
		private readonly onTick: () => void,
	) {
		super(budget);
		// 80ms 一帧是转轮的经典节奏；秒表借同一根定时器走字，不必另开一路。
		this.timer = setInterval(() => {
			this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
			this.onTick();
		}, 80);
	}

	/** 停表。弹窗被收掉（handle.hide 或 Esc）之后必须调，否则定时器空转到进程退出。 */
	stop(): void {
		if (this.timer !== undefined) clearInterval(this.timer);
		this.timer = undefined;
	}

	protected override minContentRows(): number {
		return 1;
	}

	override footerText(): string {
		// 旧版提示是空的，Esc 能关却看不见；这句是它第一次可见。
		return 'Esc dismiss';
	}

	protected override renderContent(width: number): string[] {
		const left = `${SPINNER_FRAMES[this.frame]!} ${this.text}`;
		const elapsed = `${Math.floor((Date.now() - this.startedAt) / 1000)}s`;
		const lines = wrapTextWithAnsi(left, Math.max(1, width - visibleWidth(elapsed) - 4));
		const first = lines[0] ?? '';
		const pad = ' '.repeat(Math.max(1, width - visibleWidth(first) - visibleWidth(elapsed) - 2));
		return [
			theme.fg('mdText', `${first}${pad}${theme.fg('dim', elapsed)}`),
			...lines.slice(1).map((line) => theme.fg('mdText', line)),
		];
	}
}

class LoadingDialog extends DialogShell {
	private readonly body: LoadingBody;

	constructor(title: string, text: string, budget: () => number, onTick: () => void) {
		super(title, budget);
		this.body = new LoadingBody(text, budget, onTick);
		this.addBody(this.body);
	}

	/** 停表；closeHandler 与 handle.hide 两条收尾路都会调它。 */
	stop(): void {
		this.body.stop();
	}

	handleInput(data: string): void {
		// 等待不锁人：Esc / Enter 都能提前收掉弹窗，请求本身继续跑，结果照常处理。
		if (matchesKey(data, 'escape') || matchesKey(data, 'enter') || matchesKey(data, 'ctrl+c')) this.close();
	}
}

/**
 * 加载中弹窗：无交互正文，调用方完成后自行 handle.hide() 收掉。
 *
 * 转轮 + 秒表走字，Esc / Enter 提前关（提示写在底边框上）。宽度独立成 ~54 列的窄档——
 * 一句话的等待不该占 select 档的 72%。
 */
export function showLoadingDialog(
	tui: TUI,
	options: { title: string; text: string; width?: SizeValue; priority?: number },
): OverlayHandle {
	const maxHeight: SizeValue = '30%';
	const width: SizeValue = options.width ?? '54%';
	const dialog = new LoadingDialog(options.title, options.text, () => rowBudget(tui, maxHeight), () =>
		tui.requestRender(),
	);
	const raw = tui.showOverlay(dialog, overlayOptions('select', maxHeight, options.priority, width, 54));
	// 收弹窗的两条路都要停表：调用方 handle.hide()，或用户提前 Esc。
	dialog.setCloseHandler(() => dialog.stop());
	const handle: OverlayHandle = {
		hide: () => {
			dialog.stop();
			raw.hide();
		},
		setHidden: (hidden) => raw.setHidden(hidden),
		isHidden: () => raw.isHidden(),
		focus: () => raw.focus(),
		unfocus: (unfocusOptions) => raw.unfocus(unfocusOptions),
		isFocused: () => raw.isFocused(),
		getBounds: () => raw.getBounds(),
	};
	return handle;
}

/** 只读长文本对话框（帮助、状态、待办、任务等）。 */
export function showMessageDialog(
	tui: TUI,
	options: {
		title: string;
		text: string;
		hint?: string;
		width?: SizeValue;
		maxHeight?: SizeValue;
		/** 覆盖本档列上限。百分比宽度在宽终端上会被 maxWidth 夹住，不传则仍用 document 档。 */
		maxWidth?: number;
		priority?: number;
		row?: SizeValue;
		/** 铺画布底（与终端同色），不铺浮层面 dialogBg。 */
		transparent?: boolean;
		/**
		 * 条目排成词项列（`- \`term\` — desc` → 两列，连接号不上屏）。
		 *
		 * 只由「我们自己排版」的报告点名开：计划复核那种模型自己写的正文里，`—` 是作者的
		 * 标点，替它吃掉就是改用户内容。
		 */
		termColumns?: boolean;
	},
): Promise<void> {
	return new Promise((resolve) => {
		const maxHeight = maxHeightFor('document', options.maxHeight);
		const dialog = new MessageDialog(
			options.title,
			options.text,
			options.hint ?? 'Esc close',
			() => rowBudget(tui, maxHeight),
			options.transparent === true,
			options.termColumns === true,
		);
		const overlay = overlayOptions('document', maxHeight, options.priority, options.width, options.maxWidth, options.row);
		const handle = tui.showOverlay(dialog, overlay);
		const finish = settleOnce<void>(handle, resolve);
		dialog.setCloseHandler(() => finish());
	});
}
