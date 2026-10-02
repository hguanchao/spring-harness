import { AltScreenFlashContainer } from "@/tui/screen/alt-screen-flash.js";
import { ScrollView } from "@/tui/widgets/scroll-view.js";
import { getKeybindings } from "@/tui/input/keybindings.js";
import { isKeyRelease } from "@/tui/terminal/keys.js";
import {
	compositeScrollbars,
	contentPaintRight,
	getLayoutBoxesAt,
	getScrollbarGeometry,
	getScrollViewBox,
	getScrollViewsAt,
	selectionBlockRows,
	type LayoutFrame,
	renderLayoutFrame,
	type ScrollbarGeometry,
} from "@/tui/screen/layout.js";
import { getLayoutNode } from "@/tui/screen/layout.js";
import type { Terminal } from "@/tui/terminal/terminal.js";
import {
	type ClipboardCopy,
	type Component,
	Container,
	CURSOR_MARKER,
	SUPPRESS_MULTI_CLICK_SELECTION,
	compositeTuiLine,
	dispatchMouseEvent,
	retargetMouseEvent,
	TuiBase,
	type TuiMouseButton,
	type TuiMouseDispatchResult,
	type TuiMouseDispatchTarget,
	type TuiMouseEvent,
	type TuiStopOptions,
	VIEWPORT_TUI,
	type ViewportTUI,
} from "@/tui/screen/tui.js";
import {
	clipLineToWidth,
	bubbleTextColumns,
	selectionLineEnd,
	textStartColumn,
	snapBubbleSelection,
	snapRangeSelectionPoint,
	extractAnsiCode,
	getGraphemeCellRange,
	getOsc8LinkAtColumn,
	getWordSegmenter,
	OSC133_ZONE_PREFIX,
	sliceByColumn,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "@/tui/text/utils.js";


const ENTER_ALT_SCREEN = "\x1b[?1049h";
const EXIT_ALT_SCREEN = "\x1b[?1049l";
const DISABLE_AUTOWRAP = "\x1b[?7l";
const ENABLE_AUTOWRAP = "\x1b[?7h";
const ENABLE_BUTTON_MOTION_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1004h\x1b[?1006h";
const ENABLE_ALL_MOTION_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l";
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
const BEGIN_SYNCHRONIZED_OUTPUT = "\x1b[?2026h";
const END_SYNCHRONIZED_OUTPUT = "\x1b[?2026l";
const OSC133_PROMPT_START = /^\x1b\]133;A(?:\x07|\x1b\\)/;
const PAGE_SCROLL_OVERLAP = 4;
const ALT_WHEEL_SCROLL_MULTIPLIER = 5;
const DOUBLE_CLICK_INTERVAL_MS = 500;
// Regular mode delegates double-click selection to the terminal emulator. Fullscreen owns mouse selection,
// so mirror common terminal word-selection behavior by keeping paths and kebab-case tokens whole.
const TERMINAL_WORD_SELECTION_JOINERS = new Set(["/", "-"]);
const wordSegmenter = getWordSegmenter();

/** 布局叶子常常是承载容器（editorContainer），焦点在子组件 Editor 上。 */
function componentTreeContains(root: Component, target: Component): boolean {
	if (root === target) return true;
	const children = (root as Container).children;
	if (!Array.isArray(children)) return false;
	return children.some((child) => componentTreeContains(child, target));
}

/** 框线字形：`renderRoundedBox` 与 markdown 表格共用的一套，用来检出浮层边框。 */
const FRAME_GLYPHS = "│─┌┐└┘╭╮╰╯├┤┬┴┼";

interface SelectionPoint {
	row: number;
	col: number;
	scrollView?: ScrollView;
	/** Whether this point lies between terminal cells rather than on a cell. */
	boundary?: boolean;
}

interface SelectionRange {
	start: SelectionPoint;
	end: SelectionPoint;
}

type SelectionGranularity = "character" | "word" | "line";

interface ClickTarget {
	timestamp: number;
	count: number;
	row: number;
	scrollView?: ScrollView;
	wordStart: number;
	wordEnd: number;
}

interface SgrMouseEvent {
	button: number;
	x: number;
	y: number;
	release: boolean;
}

interface WheelEvent {
	direction: -1 | 1;
	x: number;
	y: number;
	button: number;
}

interface ScrollbarDrag {
	scrollView: ScrollView;
	grabOffset: number;
	/** 按下时冻结，拖动中不重算，避免滑块高度跟着 pin-reserve / 流式内容乱跳。 */
	geometry: ScrollbarGeometry;
}

interface ScrollbarTarget {
	scrollView: ScrollView;
	geometry: ScrollbarGeometry;
}

interface ScrollToEndIndicatorRect {
	row: number;
	column: number;
	width: number;
}

export interface ViewportOverlayRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * 产品画在备用屏幕上的叠层。
 *
 * 行选中和吸顶气泡都认识具体消息块，控件层只在进屏、命中、点空白和合成这四个点调用。
 * 不注入时这些行为不存在，备用屏幕仍能滚动和划词。
 */
export interface ViewportChrome {
	reset(): void;
	hitRects(frame: LayoutFrame): readonly ViewportOverlayRect[];
	/** 点在组件未接管的区域。返回 true 表示选中变了，需要重绘。 */
	pressEmpty(components: readonly Component[]): boolean;
	composite(screen: string[], frame: LayoutFrame, width: number): string[];
}

export interface TuiAltScreenOptions {
	/** Number of logical lines moved for each mouse-wheel event. */
	wheelScrollLines?: number;
	/** Capture mouse events for viewport scrolling and application-owned text selection. */
	mouse?: boolean;
	/**
	 * Render a clickable jump-to-end label. It is centered on the last row of a follow-end
	 * primary scroll view while that view is scrolled away from its end.
	 */
	scrollToEndIndicator?: () => string;
	/** Open an OSC 8 hyperlink activated with a primary-button click. */
	openUrl?: (url: string) => void;
	/**
	 * Copy selected text to the system clipboard and report where it actually landed:
	 * `native` (a platform tool exited 0), `osc52` (handed to the terminal, unverified), or
	 * `failed`. The widget turns that into status-line wording, so a copy that never reached
	 * the clipboard cannot claim "Copied!". When omitted, the selection is copied via an OSC 52
	 * write and reported as `osc52`.
	 */
	copySelection?: (text: string) => Promise<ClipboardCopy>;
	/**
	 * 复制反馈文案的路由。设置后复制提示交给应用（如落到输入框右上角的状态行），
	 * 不再走全屏 flash；未设置保持原行为。
	 */
	onCopyFeedback?: (message: string) => void;
	/**
	 * 划词高亮的固定底色 + 块内字色。缺省用反显（SGR 7）：反显拿前景色当背景色，
	 * 彩色文字划选时底色就是文字色本身，既刺眼又难读。
	 *
	 * 想要终端原生拖选的观感，接主题传 `theme.selectionStyle()`——实心块 + 对比字色，
	 * 与 Windows Terminal 一致（块底=终端默认前景，字色按块底明度取黑/白）。
	 */
	selectionStyle?: SelectionHighlight;
	/**
	 * 备用屏幕进出时写在 1049 前后的画布序列。缺省不改终端底色。
	 * 用函数是因为配色可能在启动后才定，进屏时再取。
	 */
	canvas?: { set(): string; reset(): string };
	/** 产品叠层。见 ViewportChrome。 */
	chrome?: ViewportChrome;
}

/** 划词高亮的一组 SGR：块底，以及块内被迫替换的文字色。 */
export interface SelectionHighlight {
	/** 裸背景 SGR，如 `\x1b[48;5;236m`。 */
	bg: string;
	/** 裸前景 SGR：块底会盖掉文字自己的颜色，字色必须一起换，否则浅底浅字看不见。 */
	fg: string;
}

/** 指针在滚动视口之外才自动滚。贴在首行或末行上拖选，不把选区扩到文档两头。 */
export function selectionAutoScrollDirection(pointerY: number, visibleTop: number, visibleBottom: number): -1 | 0 | 1 {
	if (pointerY < visibleTop) return -1;
	if (pointerY > visibleBottom) return 1;
	return 0;
}

interface VerticalShift {
  /** 正数：内容上移（screen[row] 等于 previous[row + delta]）。 */
  delta: number;
  top: number;
  bottom: number;
}

/**
 * 找一段纯垂直平移。终端用滚动区把这段像素挪走，只重画滚出来的新行和吸顶、滑块那些对不上的行。
 *
 * 只在「这段像素真的整体平移」时才成立：滑块钉在视口上不跟正文走，浮层的边框同理，
 * 都得由调用方先挡住（见 paintScreenDiff 的 hasOverlay），否则滚动区会把它们一起卷走。
 */
function verticalShift(screen: readonly string[], previous: readonly string[], height: number): VerticalShift | undefined {
  // 滑块钉在视口上，不跟正文走。滚动区会把 █ 一起卷走，下一帧只补一部分行，滑块就会闪、会断。
  if (screen.some((line) => line.includes("█")) || previous.some((line) => line.includes("█"))) return undefined;
  let best: VerticalShift & { length: number } | undefined;
  const maxDelta = Math.min(8, height - 1);
  for (let distance = 1; distance <= maxDelta; distance++) {
    for (const sign of [1, -1] as const) {
      const delta = distance * sign;
      let runStart = -1;
      for (let row = 0; row <= height; row++) {
        const src = row + delta;
        const match = row < height && src >= 0 && src < previous.length && screen[row] === previous[src];
        if (match && runStart < 0) runStart = row;
        if (!match && runStart >= 0) {
          const length = row - runStart;
          if (length >= 4 && (best === undefined || length > best.length)) {
            best = { delta, top: runStart, bottom: row - 1, length };
          }
          runStart = -1;
        }
      }
    }
  }
  if (best === undefined) return undefined;
  return { delta: best.delta, top: best.top, bottom: best.bottom };
}

function rowKeptByShift(
  row: number,
  shift: VerticalShift | undefined,
  screen: readonly string[],
  previous: readonly string[],
): boolean {
  if (shift === undefined) return false;
  const src = row + shift.delta;
  if (src < 0 || src >= previous.length || screen[row] !== previous[src]) return false;
  if (shift.delta > 0) return row >= shift.top && row <= shift.bottom - shift.delta;
  return row >= shift.top - shift.delta && row <= shift.bottom;
}

/**
 * 把这一帧和上一帧比完再写终端。未改的行跳过；宽高变了才清屏。
 * 整段只是上下平移时用终端滚动区挪像素，不再把视口每一行擦掉重写。
 * 清行用默认底（OSC 11 / SGR 49），不用真彩 48;2，避免 Windows Terminal 上画出浅带。
 */
export function paintScreenDiff(options: {
  screen: readonly string[];
  previous: readonly string[];
  previousWidth: number;
  previousHeight: number;
  width: number;
  height: number;
  cursor?: { row: number; col: number } | null;
  showHardwareCursor?: boolean;
  /**
   * 屏幕上有浮层时为 true：禁用滚动区挪像素。
   *
   * 浮层（对话框）里还有自己的固定边框与内边距，它们不随正文滚动；滚动区会把整段像素
   * 一起卷走，下一帧又只补一部分行，边框就会错位。转录区那边有滚动条兜着（见 verticalShift
   * 的 `█` 守卫），浮层没有，所以必须由调用方把这件事告诉这里。
   */
  hasOverlay?: boolean;
}): { buffer: string; fullRedraw: boolean } {
  const { screen, previous, previousWidth, previousHeight, width, height, cursor, showHardwareCursor } = options;
  const fullRedraw = previous.length === 0 || previousWidth !== width || previousHeight !== height;
  let buffer = BEGIN_SYNCHRONIZED_OUTPUT;
  if (fullRedraw) buffer += `\x1b[49m\x1b[2J`;
  const shift = fullRedraw || options.hasOverlay === true ? undefined : verticalShift(screen, previous, height);
  if (shift) {
    const top = shift.top + 1;
    const bottom = shift.bottom + 1;
    const distance = Math.abs(shift.delta);
    // S 内容上移，T 内容下移。区域用完立刻复位，避免把光标和后续行卷进滚动区。
    buffer += `\x1b[${top};${bottom}r\x1b[${distance}${shift.delta > 0 ? "S" : "T"}\x1b[r`;
  }
  for (let row = 0; row < height; row++) {
    if (!fullRedraw && screen[row] === previous[row]) continue;
    if (!fullRedraw && rowKeptByShift(row, shift, screen, previous)) continue;
    buffer += `\x1b[${row + 1};1H\x1b[49m\x1b[2K${screen[row] ?? ""}`;
  }
  if (cursor) {
    buffer += `\x1b[${cursor.row + 1};${Math.min(width, cursor.col) + 1}H`;
    buffer += showHardwareCursor ? "\x1b[?25h" : "\x1b[?25l";
  } else {
    buffer += "\x1b[?25l";
  }
  buffer += END_SYNCHRONIZED_OUTPUT;
  return { buffer, fullRedraw };
}

/**
 * 划词高亮：给选中片段铺一层实心底并换成对比字色，与终端原生拖选同一套画法。
 *
 * 反显（SGR 7）与固定样式的生命周期同构：开头开启，之后每个 SGR 码都可能是 0（全重置）
 * 或自带前景/背景色，会把高亮冲掉，所以每个 SGR 码之后重申一次；OSC 8 等非 SGR 序列
 * 不改属性，不重申。结尾复位，防止高亮渗给选区之后的行文。
 */
export function applySelectionHighlight(text: string, style?: SelectionHighlight): string {
	const [on, off] =
		style === undefined
			? ["\x1b[7m", "\x1b[27m"]
			: [`${style.bg}${style.fg}`, "\x1b[39m\x1b[49m"];
	let result = on;
	let index = 0;
	while (index < text.length) {
		const ansi = extractAnsiCode(text, index);
		if (!ansi) {
			result += text[index];
			index += 1;
			continue;
		}
		result += ansi.code;
		if (ansi.code.endsWith("m")) result += on;
		index += ansi.length;
	}
	return `${result}${off}`;
}

/** Alternate-screen TUI with a scrollable, application-owned viewport. */
export class TuiAltScreen extends TuiBase implements ViewportTUI {
	readonly mode = "fullscreen" as const;
	readonly [VIEWPORT_TUI] = true as const;
	private previousScreen: string[] = [];
	private lastDocument: string[] = [];
	private previousScreenWidth = 0;
	private previousScreenHeight = 0;
	private layoutRoot: Component | undefined;
	private currentLayout: LayoutFrame | undefined;
	private readonly implicitDocument: Component;
	private readonly implicitScrollView: ScrollView;
	private readonly flashes: AltScreenFlashContainer;
	private altScreenActive = false;
	private selectionAnchor?: SelectionPoint;
	/** 这次拖选开始时所在的内容块。选区不跨出这块。 */
	private selectionBlock?: { start: number; end: number };
	/**
	 * 这次拖选开始的浮层矩形（弹窗）。选区不跨出这块。
	 *
	 * 没有它的话，弹窗里拖选会顺着**合成后**的整行取文本：合成行是「床底转录 + 弹窗 + 转录」，
	 * 而横线的取法是「行首到行尾」，行尾在窗外的转录上——于是选弹窗里两行，拷出来的是整屏。
	 * 高亮同理，会顺着行尾糊到窗外。
	 */
	private selectionRect?: { row: number; col: number; width: number; height: number };
	/** 按下时的原始格（未做词吸附）：松开判定 isClick 用它，而不是被 range 起点顶掉的 anchor。 */
	private selectionPressCell?: { scrollView?: ScrollView; row: number; col: number };
	private selectionFocus?: SelectionPoint;
	private selectionGranularity: SelectionGranularity = "character";
	private selectionInitialRange?: SelectionRange;
	private lastClick?: ClickTarget;
	private selectionDragPointer?: { x: number; y: number };
	private selectionAutoScrollDirection: -1 | 0 | 1 = 0;
	private selectionAutoScrollTimer?: NodeJS.Timeout;
	private selectionPressActive = false;
	private scrollbarDrag?: ScrollbarDrag;
	private scrollbarHover?: ScrollView;
	private scrollToEndIndicatorRect?: ScrollToEndIndicatorRect;
	private pressedUrl?: string;
	private selectionDragged = false;
	/**
	 * 终端焦点在不在这个窗口里。1004 上报早就开着（`ENABLE_ALL_MOTION_MOUSE` 里的 `?1004h`），
	 * 以前收到 `\x1b[I`/`\x1b[O` 只拿来清选区，现在顺手记一笔：完成提醒要在「你正盯着」时闭嘴。
	 * 默认 true：不上报焦点的终端等于一直在跟前，宁可少响。
	 */
	private terminalHasFocus = true;
	private mouseCapture?: TuiMouseDispatchTarget;
	private mousePressTarget?: TuiMouseDispatchTarget;
	private mousePressPoint?: { x: number; y: number };
	private mousePressMoved = false;
	private lastComponentClick?: {
		timestamp: number;
		count: number;
		component: Component;
		x: number;
		y: number;
	};
	private readonly wheelScrollLines: number;
	private readonly mouseEnabled: boolean;
	private readonly scrollToEndIndicator?: () => string;
	private readonly openUrl?: (url: string) => void;
	private readonly copySelection?: (text: string) => Promise<ClipboardCopy>;
	private readonly onCopyFeedback?: (message: string) => void;
	private readonly selectionStyle?: SelectionHighlight;
	private readonly canvas?: { set(): string; reset(): string };
	private readonly chrome?: ViewportChrome;
	/** 转录内容世代：滚动不递增，避免每帧重排整份对话。 */
	private contentGeneration = 0;
	/** 鼠标移动观察者：每个 move/drag 事件在组件分发前触发一次（见 TUI 接口说明）。 */
	onMouseMotion?: (x: number, y: number) => void;
	finishMouseMotion?: () => void;
	prepareMouseClick?: () => void;
	finishMouseClick?: () => boolean;

	constructor(
		terminal: Terminal,
		showHardwareCursor?: boolean,
		logDirectory?: string,
		options: TuiAltScreenOptions = {},
	) {
		super(terminal, showHardwareCursor, logDirectory);
		this.implicitDocument = {
			render: (width) => super.render(width),
			handleMouse: (event) => super.handleMouse(event),
			invalidate: () => {
				for (const child of this.children) child.invalidate();
			},
		};
		this.implicitScrollView = new ScrollView(this.implicitDocument, { follow: "end", primary: true });
		this.flashes = new AltScreenFlashContainer(() => this.requestRender());
		// 一格滚轮一行。终端滚轮只有方向、没有像素距离，默认 3 行会一截一截跳。
		this.wheelScrollLines = Math.max(1, Math.floor(options.wheelScrollLines ?? 1));
		this.mouseEnabled = options.mouse ?? true;
		this.scrollToEndIndicator = options.scrollToEndIndicator;
		this.openUrl = options.openUrl;
		this.copySelection = options.copySelection;
		this.onCopyFeedback = options.onCopyFeedback;
		this.selectionStyle = options.selectionStyle;
		this.canvas = options.canvas;
		this.chrome = options.chrome;
		this.addInputListener((data) => this.handleViewportInput(data));
	}

	setLayoutRoot(component: Component | undefined): void {
		if (this.layoutRoot === component) return;
		this.layoutRoot = component;
		this.currentLayout = undefined;
		this.requestRender();
	}

	/**
	 * 最近一帧真正画出去的**合成结果**（每个元素是一整行）。
	 *
	 * 断言「屏幕上现在是什么」不必去解析 ANSI 差分字节流：差分是为了少写字节，而帧是渲染的
	 * 产物，两者之间隔着垂直位移、跳行、行尾擦除等一堆编码细节。帧测试要的是产物本身。
	 * ANSI 编码那一层由 `paintScreenDiff` 的纯函数用例单独钉。
	 *
	 * 与 `render(width)` 的区别：那个是**还没合成**的布局输出（没有浮层、没有闪光、
	 * 没有滚动条），这个是用户真正看到的那一屏。帧测试要后者。
	 */
	frame(): readonly string[] {
		return this.previousScreen;
	}

	override render(width: number): string[] {
		return this.layoutRoot?.render(width) ?? super.render(width);
	}

	protected override getMountedRoots(): readonly Component[] {
		return this.layoutRoot ? [this.layoutRoot] : this.children;
	}

	private getPrimaryScrollView(): ScrollView {
		return this.currentLayout?.primaryScrollView ?? this.implicitScrollView;
	}

	protected override beforeTerminalStart(): void {
		this.stopSelectionAutoScroll();
		this.selectionPressActive = false;
		this.stopScrollbarHover();
		this.stopScrollbarDrag();
		this.flashes.dispose();
		this.altScreenActive = true;
		this.lastDocument = [];
		this.clearSelectionState();
		this.chrome?.reset();
		this.lastClick = undefined;
		this.pressedUrl = undefined;
		this.selectionDragged = false;
		this.clearComponentMouseGesture();
		this.lastComponentClick = undefined;
		this.resetRenderState();
		const term = process.env.TERM?.toLowerCase() ?? "";
		// Multiplexers can lag when every pointer movement is forwarded. Button-motion
		// tracking preserves clicks, wheel events, selections, and scrollbar dragging.
		const mouseSequence =
			process.env.TMUX !== undefined ||
			process.env.ZELLIJ !== undefined ||
			process.env.STY !== undefined ||
			term.startsWith("tmux") ||
			term.startsWith("screen")
				? ENABLE_BUTTON_MOTION_MOUSE
				: ENABLE_ALL_MOTION_MOUSE;
		this.terminal.write(
			`${ENTER_ALT_SCREEN}${DISABLE_AUTOWRAP}${this.mouseEnabled ? mouseSequence : ""}${this.canvas?.set() ?? ""}\x1b[49m\x1b[2J\x1b[H\x1b[?25l`,
		);
	}

	protected override beforeTerminalStop(_options: TuiStopOptions): void {
		this.stopSelectionAutoScroll();
		this.selectionPressActive = false;
		this.stopScrollbarHover();
		this.stopScrollbarDrag();
		this.clearComponentMouseGesture();
		this.flashes.dispose();
		if (!this.altScreenActive) return;
		this.terminal.write(
			`${BEGIN_SYNCHRONIZED_OUTPUT}${this.mouseEnabled ? DISABLE_MOUSE : ""}${ENABLE_AUTOWRAP}${END_SYNCHRONIZED_OUTPUT}`,
		);
	}

	protected override afterTerminalStop(options: TuiStopOptions): void {
		if (!this.altScreenActive) return;
		this.altScreenActive = false;
		if (options.preserveScreen) {
			this.terminal.write(
				`${BEGIN_SYNCHRONIZED_OUTPUT}${this.canvas?.reset() ?? ""}${EXIT_ALT_SCREEN}\x1b[?25h${END_SYNCHRONIZED_OUTPUT}`,
			);
		} else {
			const width = Math.max(1, this.terminal.columns);
			const documentLines = this.render(width).map((line) => line.replace(OSC133_ZONE_PREFIX, ""));
			this.lastDocument = this.applyLineResets(documentLines.map((line) => line.replaceAll(CURSOR_MARKER, ""))).map(
				(line) => clipLineToWidth(line, width),
			);
			let buffer = `${BEGIN_SYNCHRONIZED_OUTPUT}${this.canvas?.reset() ?? ""}${EXIT_ALT_SCREEN}${DISABLE_AUTOWRAP}`;
			for (let row = 0; row < this.lastDocument.length; row++) {
				if (row > 0) buffer += "\r\n";
				buffer += `\r\x1b[2K${this.lastDocument[row] ?? ""}`;
			}
			buffer += `\x1b[0m${ENABLE_AUTOWRAP}\r\n\x1b[?25h${END_SYNCHRONIZED_OUTPUT}`;
			this.terminal.write(buffer);
		}
	}

	protected override resetRenderState(): void {
		this.contentGeneration += 1;
		this.previousScreen = [];
		this.previousScreenWidth = 0;
		this.previousScreenHeight = 0;
		this.currentLayout = undefined;
	}

	override requestRender(force = false): void {
		// 内容世代只在结构变化时递增。鼠标、选区、滚动走 requestViewportRender，
		// 否则 ScrollView 会把整份转录当成新内容重排。
		if (force) this.contentGeneration += 1;
		super.requestRender(force);
	}

	override requestViewportRender(): void {
		this.requestImmediateRender();
	}

	scrollBy(lines: number): void {
		this.getPrimaryScrollView().scrollBy(lines);
		this.requestViewportRender();
	}

	scrollToTop(): void {
		this.getPrimaryScrollView().scrollToStart();
		this.requestViewportRender();
	}

	scrollToBottom(): void {
		this.getPrimaryScrollView().scrollToEnd();
		this.requestViewportRender();
	}

	private scrollToPrompt(direction: -1 | 1): void {
		if (!this.currentLayout) return;
		const scrollView = this.getPrimaryScrollView();
		const lines = getScrollViewBox(this.currentLayout, scrollView)?.scrollContentLines;
		if (!lines) return;

		for (let row = scrollView.scrollTop + direction; row >= 0 && row < lines.length; row += direction) {
			if (!OSC133_PROMPT_START.test(lines[row] ?? "")) continue;
			scrollView.scrollTo(row);
			this.requestViewportRender();
			return;
		}
	}

	/** Show a transient message in the alternate-screen flash stack. */
	flash(message: string, durationMs?: number): void {
		this.flashes.flash(message, durationMs);
	}

	private shouldDeferViewportInputToOverlay(): boolean {
		return this.isOverlayFocused();
	}

	private clearComponentMouseGesture(): void {
		this.mouseCapture = undefined;
		this.mousePressTarget = undefined;
		this.mousePressPoint = undefined;
		this.mousePressMoved = false;
	}

	private handleViewportInput(data: string): { consume?: boolean } | undefined {
		if (data === FOCUS_OUT) {
			this.terminalHasFocus = false;
			const hadActiveSelection = this.selectionPressActive;
			const hadNonEmptyActiveSelection = hadActiveSelection && this.getSelectionBounds() !== undefined;
			this.selectionPressActive = false;
			this.stopSelectionAutoScroll();
			this.stopScrollbarHover();
			this.stopScrollbarDrag();
			this.pressedUrl = undefined;
			this.selectionDragged = false;
			this.clearComponentMouseGesture();
			this.lastComponentClick = undefined;
			if (hadActiveSelection) {
				this.clearSelectionState();
				if (hadNonEmptyActiveSelection) this.requestViewportRender();
			}
			this.lastClick = undefined;
			return { consume: true };
		}
		if (data === FOCUS_IN) {
			this.terminalHasFocus = true;
			return { consume: true };
		}

		const wheelEvent = this.parseWheelEvent(data);
		if (wheelEvent) {
			const event = this.createMouseEvent("wheel", wheelEvent.button, wheelEvent.x, wheelEvent.y, {
				wheelDelta: wheelEvent.direction * this.getWheelScrollLines(wheelEvent.button),
			});
			const overlay = this.dispatchMouseToOverlay(event);
			const result = overlay.result ?? (overlay.hit ? undefined : this.dispatchMouseToLayout(event));
			if (result) {
				if (this.applyMouseDispatchResult(event, result)) this.requestViewportRender();
				return { consume: true };
			}
			if (this.shouldDeferViewportInputToOverlay()) return undefined;
			this.routeWheel(wheelEvent);
			return { consume: true };
		}
		const mouseEvent = this.parseSgrMouseEvent(data);
		if (mouseEvent) {
			this.handleMouseEvent(mouseEvent);
			return { consume: true };
		}
		if (this.isMouseSequence(data)) return { consume: true };

		const keybindings = getKeybindings();
		const isRelease = isKeyRelease(data);
		if (this.shouldDeferViewportInputToOverlay()) return undefined;
		if (keybindings.matches(data, "tui.altScreen.pageUp")) {
			if (!isRelease) {
				this.scrollBy(-Math.max(1, this.getPrimaryScrollView().viewportHeight - PAGE_SCROLL_OVERLAP));
			}
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.pageDown")) {
			if (!isRelease) {
				this.scrollBy(Math.max(1, this.getPrimaryScrollView().viewportHeight - PAGE_SCROLL_OVERLAP));
			}
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.previousPrompt")) {
			if (!isRelease) this.scrollToPrompt(-1);
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.nextPrompt")) {
			if (!isRelease) this.scrollToPrompt(1);
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.top")) {
			if (!isRelease) this.scrollToTop();
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.bottom")) {
			if (!isRelease) this.scrollToBottom();
			return { consume: true };
		}
		return undefined;
	}

	private decodeMouseButton(button: number): TuiMouseButton {
		switch (button & 3) {
			case 0:
				return "left";
			case 1:
				return "middle";
			case 2:
				return "right";
			default:
				return "none";
		}
	}

	private createMouseEvent(
		type: TuiMouseEvent["type"],
		button: number,
		x: number,
		y: number,
		extra: Partial<Pick<TuiMouseEvent, "wheelDelta" | "clickCount">> = {},
	): TuiMouseEvent {
		return {
			type,
			button: type === "wheel" ? "none" : this.decodeMouseButton(button),
			x,
			y,
			screenX: x,
			screenY: y,
			width: Math.max(1, this.terminal.columns),
			height: Math.max(1, this.terminal.rows),
			shift: (button & 4) !== 0,
			alt: (button & 8) !== 0,
			ctrl: (button & 16) !== 0,
			...(extra.wheelDelta === undefined ? {} : { wheelDelta: extra.wheelDelta }),
			...(extra.clickCount === undefined ? {} : { clickCount: extra.clickCount }),
		};
	}

	private dispatchMouseToLayout(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		if (!this.currentLayout) return undefined;
		// 吸顶用户气泡是合成层（直接画在屏幕缓冲上），不在布局树里、命中判定天然看不见它。
		// 放行的话点它会点穿到气泡底下的转录行——双击吸顶气泡会误触底下工具行的开合。
		// 按下/点击/拖拽在气泡占据的矩形内一律不下发；滚轮与纯移动放行，滚动与划选不受影响。
		if (event.type === "press" || event.type === "click" || event.type === "drag") {
			const insideSticky = (this.chrome?.hitRects(this.currentLayout) ?? []).some(
				(rect) =>
					event.screenX >= rect.x &&
					event.screenX < rect.x + rect.width &&
					event.screenY >= rect.y &&
					event.screenY < rect.y + rect.height,
			);
			if (insideSticky) return undefined;
		}
		const visited = new Set<Component>();
		const boxes = getLayoutBoxesAt(this.currentLayout, event.screenX, event.screenY);
		for (const box of boxes) {
			if (visited.has(box.component)) continue;
			if (getLayoutNode(box.component) && box.component.handleMouse === Container.prototype.handleMouse) continue;
			visited.add(box.component);
			const result = dispatchMouseEvent(box.component, {
				...event,
				x: event.screenX - box.rect.x,
				y: event.screenY - box.rect.y,
				width: box.rect.width,
				height: box.rect.height,
			});
			if (result) return result;
		}
		return undefined;
	}

	private applyMouseDispatchResult(event: TuiMouseEvent, result: TuiMouseDispatchResult): boolean {
		const focusTarget = this.resolveMouseFocusTarget(result.focusTarget ?? result.target.component);
		const focusChanged = result.focus === true && this.getFocusedComponent() !== focusTarget;
		if (result.focus) this.setFocus(focusTarget);
		if (result.capture) this.mouseCapture = result.target;
		return (
			result.render ??
			(focusChanged ||
				event.type === "press" ||
				event.type === "click" ||
				event.type === "drag" ||
				event.type === "wheel")
		);
	}

	private dispatchMouseToTarget(
		event: TuiMouseEvent,
		target: TuiMouseDispatchTarget,
	): TuiMouseDispatchResult | undefined {
		return dispatchMouseEvent(target.component, retargetMouseEvent(event, target));
	}

	/**
	 * 左键 click 包一层认领：分发前清标记，行自己的处理函数再认领。
	 * 没人认领就取消工具行选中，并让转录缓存失效——选中底画在内容行上。
	 */
	private dispatchMouseClick(
		event: TuiMouseEvent,
		dispatch: () => TuiMouseDispatchResult | undefined,
	): TuiMouseDispatchResult | undefined {
		const track = event.button === "left";
		if (track) this.prepareMouseClick?.();
		const result = dispatch();
		if (track && this.finishMouseClick?.()) this.invalidateContent();
		return result;
	}

	private getComponentClickCount(target: TuiMouseDispatchTarget, x: number, y: number): number {
		const now = Date.now();
		const previous = this.lastComponentClick;
		const count =
			previous &&
			now - previous.timestamp <= DOUBLE_CLICK_INTERVAL_MS &&
			previous.component === target.component &&
			previous.x === x &&
			previous.y === y
				? (previous.count % 3) + 1
				: 1;
		this.lastComponentClick = { timestamp: now, count, component: target.component, x, y };
		return count;
	}

	/** 清空拖选锚点/焦点（不动拖选手势与自动滚动状态）。 */
	private clearSelectionState(): void {
		this.selectionAnchor = undefined;
		this.selectionBlock = undefined;
		this.selectionRect = undefined;
		this.selectionPressCell = undefined;
		this.selectionFocus = undefined;
		this.selectionGranularity = "character";
		this.selectionInitialRange = undefined;
	}

	private clearTextSelection(): void {
		this.stopSelectionAutoScroll();
		this.selectionPressActive = false;
		this.clearSelectionState();
		this.pressedUrl = undefined;
		this.selectionDragged = false;
	}

	private handleMouseEvent(raw: SgrMouseEvent): void {
		const isMotion = (raw.button & 32) !== 0;
		const type: TuiMouseEvent["type"] = raw.release
			? "release"
			: isMotion
				? this.decodeMouseButton(raw.button) === "none"
					? "move"
					: "drag"
				: "press";
		const event = this.createMouseEvent(type, raw.button, raw.x, raw.y);
		const trackMotion = type === "move" || type === "drag";
		if (trackMotion && this.onMouseMotion) {
			this.onMouseMotion(event.screenX, event.screenY);
		}
		try {
			this.routeMouseEvent(raw, event, type);
		} finally {
			if (trackMotion) this.finishMouseMotion?.();
		}
	}

	private routeMouseEvent(raw: SgrMouseEvent, event: TuiMouseEvent, type: TuiMouseEvent["type"]): void {
		if (this.mouseCapture || this.mousePressTarget) {
			const target = this.mouseCapture ?? this.mousePressTarget!;
			// ±1 格内的手抖不算移动：按得准松得偏一格是双击的常态，太严会把 click 吞掉，
			// 工具行的双击展开/收起就会时好时坏。
			const moved =
				this.mousePressPoint !== undefined &&
				(Math.abs(raw.x - this.mousePressPoint.x) > 1 || Math.abs(raw.y - this.mousePressPoint.y) > 1);
			if (moved) {
				this.mousePressMoved = true;
				this.lastComponentClick = undefined;
				// **移动即拖选**：按住之后真的拖起来了，这次按下就不是「点一下」，改判给拖选。
				// 组件在按下那一刻已经按点选处理过（列表高亮落到了按下的那一行），这里撤掉它的手势、
				// 用记下的按落点补一次「按下」，拖选的锚点便接上；本次事件不再进这个分支，
				// 继续往下走普通路径交给拖选。
				// 持有 capture 的组件不改判——拖动本来就是它的语义。
				if (type === "drag" && this.mouseCapture === undefined && this.mousePressPoint !== undefined) {
					const pressed = this.mousePressPoint;
					this.clearComponentMouseGesture();
					this.handleSelectionMouseEvent({ button: 0, x: pressed.x, y: pressed.y, release: false });
				}
			}
			if (this.mouseCapture !== undefined || this.mousePressTarget !== undefined) {
				let render = false;
				const targetResult = this.dispatchMouseToTarget(event, target);
				if (targetResult) render = this.applyMouseDispatchResult(event, targetResult);
				if (raw.release) {
					if (!this.mousePressMoved && this.mousePressPoint) {
						const clickEvent = this.createMouseEvent("click", raw.button, raw.x, raw.y, {
							clickCount: this.getComponentClickCount(target, raw.x, raw.y),
						});
						const clickResult = this.dispatchMouseClick(clickEvent, () => this.dispatchMouseToTarget(clickEvent, target));
						if (clickResult) render = this.applyMouseDispatchResult(clickEvent, clickResult) || render;
					}
					this.clearComponentMouseGesture();
				}
				if (render) this.requestViewportRender();
				return;
			}
		}

		const overlay = this.dispatchMouseToOverlay(event);
		if (!overlay.hit) {
			// 顶层浮层的外侧按下由它自己处理并消费：嵌套 MCP 管理器点到报告区域时，
			// 先只关闭管理器，不能让同一次按下穿透给底层报告。
			if (
				type === "press" &&
				this.decodeMouseButton(raw.button) === "left" &&
				this.handleOverlayOutsidePress(raw.x, raw.y)
			) {
				this.clearTextSelection();
				return;
			}
			if (this.handleScrollToEndIndicatorMouseEvent(raw)) return;
			const scrollbarHandled = this.handleScrollbarMouseEvent(raw);
			if (!this.scrollbarDrag) this.updateScrollbarHover(raw.x, raw.y);
			if (scrollbarHandled) return;
		} else {
			this.stopScrollbarHover();
		}

		const result = overlay.result ?? (overlay.hit ? undefined : this.dispatchMouseToLayout(event));
		if (type === "press" && this.decodeMouseButton(raw.button) === "left" && !result?.focus) {
			// 点在输入框以外（转录、页脚、空白）就失焦：否则 editor 永远 focused，边框看不出变化。
			this.blurIfPressOutsideFocus(raw.x, raw.y);
		}
		if (result) {
			const render = this.applyMouseDispatchResult(event, result);
			if (type === "press") {
				this.clearTextSelection();
				this.mousePressTarget = result.target;
				this.mousePressPoint = { x: raw.x, y: raw.y };
				this.mousePressMoved = false;
			}
			if (render) this.requestViewportRender();
			return;
		}

		if (this.handleRightClickCopy(raw)) return;
		if (type === "press" && this.decodeMouseButton(raw.button) === "left") {
			// 未被组件接管的按压（工具/思考行的正文按划词语义放行）交给 chrome。
			// 行首的 ❙ 选中标记已移除，chrome 侧的 pressEmpty 现在是空语义占位。
			const boxes = this.currentLayout ? getLayoutBoxesAt(this.currentLayout, raw.x, raw.y) : [];
			if (this.chrome?.pressEmpty(boxes.map((box) => box.component))) this.requestViewportRender();
		}
		this.handleSelectionMouseEvent(raw);
	}

	/**
	 * 右键：复制当前选区。
	 *
	 * Windows 上右键默认是粘贴（Windows Terminal 的约定），但那个约定只在「选区归终端所有」
	 * 时成立。这里的选区是应用内自绘的，右键粘贴等于用系统剪贴板覆盖刚选中的内容。所以这里
	 * 把右键定为复制：有选区就复制并反馈，没有选区不拦截，交回终端。
	 */
	private handleRightClickCopy(event: SgrMouseEvent): boolean {
		if (event.release || event.button !== 2) return false;
		if (!this.getSelectionBounds()) return false;
		void this.copyTextSelection();
		return true;
	}

	/** 命中点是否落在当前焦点组件（或其承载容器）上。 */
	private isPointOnFocusedComponent(x: number, y: number): boolean {
		const focused = this.getFocusedComponent();
		if (!focused || !this.currentLayout) return false;
		const boxes = getLayoutBoxesAt(this.currentLayout, x, y);
		const deepest = boxes[0];
		if (!deepest || deepest === this.currentLayout.root) return false;
		return componentTreeContains(deepest.component, focused);
	}

	private blurIfPressOutsideFocus(x: number, y: number): void {
		if (this.hasOverlay()) return;
		if (!this.getFocusedComponent()) return;
		if (this.isPointOnFocusedComponent(x, y)) return;
		this.setFocus(null);
		this.requestViewportRender();
	}

	private parseWheelEvent(data: string): WheelEvent | undefined {
		const sgr = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/.exec(data);
		if (sgr) {
			const button = Number.parseInt(sgr[1], 10);
			if ((button & 64) === 0) return undefined;
			const direction = button & 3;
			if (direction !== 0 && direction !== 1) return undefined;
			return {
				direction: direction === 0 ? -1 : 1,
				x: Number.parseInt(sgr[2], 10) - 1,
				y: Number.parseInt(sgr[3], 10) - 1,
				button,
			};
		}
		if (data.length === 6 && data.startsWith("\x1b[M")) {
			const button = data.charCodeAt(3) - 32;
			if ((button & 64) === 0) return undefined;
			const direction = button & 3;
			if (direction !== 0 && direction !== 1) return undefined;
			return {
				direction: direction === 0 ? -1 : 1,
				x: data.charCodeAt(4) - 33,
				y: data.charCodeAt(5) - 33,
				button,
			};
		}
		return undefined;
	}

	private getWheelScrollLines(button: number): number {
		// SGR mouse button codes use bit 3 (value 8) for the Alt modifier.
		return (button & 8) !== 0 ? this.wheelScrollLines * ALT_WHEEL_SCROLL_MULTIPLIER : this.wheelScrollLines;
	}

	private routeWheel(event: WheelEvent): void {
		let remaining = event.direction * this.getWheelScrollLines(event.button);
		const seen = new Set<ScrollView>();
		for (const scrollView of this.currentLayout ? getScrollViewsAt(this.currentLayout, event.x, event.y) : []) {
			seen.add(scrollView);
			remaining = scrollView.scrollBy(remaining);
			if (remaining === 0 || scrollView.overscroll === "contain") break;
		}
		const primary = this.getPrimaryScrollView();
		if (remaining !== 0 && !seen.has(primary)) primary.scrollBy(remaining);
		this.updateScrollbarHover(event.x, event.y);
		this.requestViewportRender();
	}

	private parseSgrMouseEvent(data: string): SgrMouseEvent | undefined {
		const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
		if (!match) return undefined;
		return {
			button: Number.parseInt(match[1], 10),
			x: Number.parseInt(match[2], 10) - 1,
			y: Number.parseInt(match[3], 10) - 1,
			release: match[4] === "m",
		};
	}

	private handleScrollToEndIndicatorMouseEvent(event: SgrMouseEvent): boolean {
		const rect = this.scrollToEndIndicatorRect;
		if (!rect || event.release || (event.button & 32) !== 0 || (event.button & 3) !== 0) return false;
		if (event.y !== rect.row || event.x < rect.column || event.x >= rect.column + rect.width) return false;
		this.scrollToBottom();
		return true;
	}

	private getScrollbarTargetAt(x: number, y: number, includeHiddenAuto = false): ScrollbarTarget | undefined {
		if (this.hasOverlay() || !this.currentLayout) return undefined;
		for (const scrollView of getScrollViewsAt(this.currentLayout, x, y)) {
			const box = getScrollViewBox(this.currentLayout, scrollView);
			const geometry = box ? getScrollbarGeometry(box, includeHiddenAuto) : undefined;
			if (
				geometry &&
				x === geometry.column &&
				y >= geometry.trackTop &&
				y < geometry.trackTop + geometry.trackHeight
			) {
				return { scrollView, geometry };
			}
		}
		return undefined;
	}

	private setScrollbarHover(scrollView: ScrollView | undefined): void {
		if (scrollView === this.scrollbarHover) return;
		this.scrollbarHover?.setScrollbarActive(false);
		this.scrollbarHover = scrollView;
		this.scrollbarHover?.setScrollbarActive(true);
	}

	private updateScrollbarHover(x: number, y: number): void {
		this.setScrollbarHover(this.getScrollbarTargetAt(x, y, true)?.scrollView);
	}

	private stopScrollbarHover(): void {
		this.setScrollbarHover(undefined);
	}

	private scrollScrollbarToPointer(
		scrollView: ScrollView,
		geometry: ScrollbarGeometry,
		pointerY: number,
		grabOffset: number,
	): void {
		const maxThumbOffset = geometry.trackHeight - geometry.thumbHeight;
		const thumbOffset = Math.max(0, Math.min(maxThumbOffset, pointerY - geometry.trackTop - grabOffset));
		const scrollTop = maxThumbOffset === 0 ? 0 : Math.round((thumbOffset / maxThumbOffset) * geometry.maxScrollTop);
		scrollView.scrollTo(scrollTop, { disableFollow: true });
	}

	private handleScrollbarMouseEvent(event: SgrMouseEvent): boolean {
		if (this.scrollbarDrag) {
			if (event.release) {
				const drag = this.scrollbarDrag;
				this.stopScrollbarDrag();
				if (drag.scrollView.scrollTop >= drag.geometry.maxScrollTop) drag.scrollView.scrollToEnd();
				this.requestViewportRender();
				return true;
			}
			this.scrollScrollbarToPointer(
				this.scrollbarDrag.scrollView,
				this.scrollbarDrag.geometry,
				event.y,
				this.scrollbarDrag.grabOffset,
			);
			return true;
		}

		if (event.release || (event.button & 32) !== 0 || (event.button & 3) !== 0) return false;
		const target = this.getScrollbarTargetAt(event.x, event.y);
		if (!target) return false;
		this.stopSelectionAutoScroll();
		this.selectionPressActive = false;
		this.clearSelectionState();
		this.lastClick = undefined;
		this.pressedUrl = undefined;
		this.selectionDragged = false;
		this.setScrollbarHover(target.scrollView);
		const onThumb =
			event.y >= target.geometry.thumbTop && event.y < target.geometry.thumbTop + target.geometry.thumbHeight;
		const grabOffset = onThumb ? event.y - target.geometry.thumbTop : Math.floor(target.geometry.thumbHeight / 2);
		if (!onThumb) this.scrollScrollbarToPointer(target.scrollView, target.geometry, event.y, grabOffset);
		this.scrollbarDrag = {
			scrollView: target.scrollView,
			grabOffset,
			geometry: target.geometry,
		};
		return true;
	}

	private stopScrollbarDrag(): void {
		this.scrollbarDrag = undefined;
	}

	private getScrollSelectionPoint(scrollView: ScrollView, x: number, y: number): SelectionPoint | undefined {
		if (!this.currentLayout) return undefined;
		const box = getScrollViewBox(this.currentLayout, scrollView);
		if (!box || box.rect.height <= 0 || box.clip.height <= 0) return undefined;
		const visibleTop = Math.max(0, box.rect.y, box.clip.y);
		const visibleBottom = Math.min(
			this.terminal.rows - 1,
			box.rect.y + box.rect.height - 1,
			box.clip.y + box.clip.height - 1,
		);
		if (visibleBottom < visibleTop) return undefined;
		const pointerRow = Math.max(visibleTop, Math.min(visibleBottom, y));
		const maxContentRow = Math.max(0, (box.scrollContentLines?.length ?? 1) - 1);
		return this.clampSelectionPoint({
			row: Math.max(0, Math.min(maxContentRow, scrollView.scrollTop + pointerRow - box.rect.y)),
			col: Math.max(0, Math.min(box.rect.width - 1, x - box.rect.x)),
			scrollView,
		});
	}

	private getSelectionPoint(event: SgrMouseEvent, scrollView?: ScrollView): SelectionPoint {
		if (scrollView) {
			const point = this.getScrollSelectionPoint(scrollView, event.x, event.y);
			if (point) return point;
		}
		const point = this.clampToSelectionRect(
			this.clampSelectionPoint({
				row: Math.max(0, Math.min(this.terminal.rows - 1, event.y)),
				col: Math.max(0, Math.min(this.terminal.columns - 1, event.x)),
			}),
		);
		return point;
	}

	/**
	 * 抓哪个浮层矩形（取最上面那个）。与 `dispatchMouseToOverlay` 同一套判定与顺序——
	 * 命中判定和选框不能各算一套，否则会出现「点得中但选不了」。
	 */
	private overlayRectAt(x: number, y: number): { row: number; col: number; width: number; height: number } | undefined {
		const rects = this.renderedOverlayRects();
		for (let index = rects.length - 1; index >= 0; index--) {
			const rect = rects[index]!;
			if (x >= rect.col && x < rect.col + rect.width && y >= rect.row && y < rect.row + rect.height) return rect;
		}
		return undefined;
	}

	/**
	 * 浮层矩形里真正装内容的那块：四周检出框线时内缩一格。
	 *
	 * 不内缩的话，弹窗里拖选拷出来每行都挂着 `│`——你框的是文字，拿到的是框；
	 * 尾列那个 `│` 还会挡住行尾裁剪，把右边一整条留白也带进剪贴板。这就是「选得不准」。
	 *
	 * **检出而不是假定**：浮层不保证是带框的盒子（补全菜单、浮层提示各有各的画法）。
	 * 检不出就按原矩形来——宁可多带一格框线，也不能凭猜吃掉别人的第一列内容。
	 */
	private overlayContentRect(rect: { row: number; col: number; width: number; height: number }): {
		row: number;
		col: number;
		width: number;
		height: number;
	} {
		if (rect.width < 4 || rect.height < 4) return rect;
		const glyphAt = (row: number, col: number): string =>
			stripTerminalSequences(sliceByColumn(this.previousScreen[row] ?? "", col, 1, true));
		for (let row = rect.row; row < rect.row + rect.height; row++) {
			if (!FRAME_GLYPHS.includes(glyphAt(row, rect.col))) return rect;
			if (!FRAME_GLYPHS.includes(glyphAt(row, rect.col + rect.width - 1))) return rect;
		}
		return { row: rect.row + 1, col: rect.col + 1, width: rect.width - 2, height: rect.height - 2 };
	}

	/** 浮层内拖选时把屏幕坐标夹进那块矩形：手拖出窗外也不该选到窗外的转录。 */
	private clampToSelectionRect(point: SelectionPoint): SelectionPoint {
		const rect = this.selectionRect;
		if (!rect) return point;
		return {
			...point,
			row: Math.max(rect.row, Math.min(rect.row + rect.height - 1, point.row)),
			col: Math.max(rect.col, Math.min(rect.col + rect.width - 1, point.col)),
		};
	}

	/** 取文本与染色共用的选区边界；浮层选区夹在浮层矩形内，否则不夹。 */
	private selectionClamp(): { minRow: number; maxRow: number; minColumn: number; maxColumn: number } | undefined {
		const rect = this.selectionRect;
		if (!rect) return undefined;
		return {
			minRow: rect.row,
			maxRow: rect.row + rect.height - 1,
			minColumn: rect.col,
			maxColumn: rect.col + rect.width,
		};
	}

	/**
	 * 行尾空白不可选。气泡灰底同样不可选：垫行只有左边框，拖在灰底上要落到正文那一行。
	 */
	private clampPointToBlock(point: SelectionPoint): SelectionPoint {
		const block = this.selectionBlock;
		if (!block || (point.row >= block.start && point.row <= block.end)) return point;
		const row = Math.max(block.start, Math.min(block.end, point.row));
		const snapped = snapRangeSelectionPoint(this.selectionSourceLines({ ...point, row }), row, point.col);
		return { ...point, row: snapped.row, col: snapped.col };
	}

	private clampSelectionPoint(point: SelectionPoint): SelectionPoint {
		const lines = this.selectionSourceLines(point);
		const snapped = snapBubbleSelection(lines, point.row, point.col);
		if (snapped) return { ...point, row: snapped.row, col: snapped.col };
		const range = snapRangeSelectionPoint(lines, point.row, point.col);
		return { ...point, row: range.row, col: range.col };
	}

	private selectionSourceLines(point: SelectionPoint): readonly string[] {
		if (point.scrollView && this.currentLayout) {
			const lines = getScrollViewBox(this.currentLayout, point.scrollView)?.scrollContentLines;
			if (lines) return lines;
		}
		return this.previousScreen;
	}

	private getSelectionSourceLine(point: SelectionPoint): string {
		return this.selectionSourceLines(point)[point.row] ?? "";
	}

	/** 命中声明了「双击不选词」的组件（工具行详情）。 */
	private hitSuppressesMultiClickSelection(x: number, y: number): boolean {
		const layout = this.currentLayout;
		if (!layout) return false;
		return getLayoutBoxesAt(layout, x, y).some(
			(box) =>
				(box.component as { [SUPPRESS_MULTI_CLICK_SELECTION]?: boolean })[SUPPRESS_MULTI_CLICK_SELECTION] ===
				true,
		);
	}

	private getWordSelection(point: SelectionPoint): SelectionRange | undefined {
		const line = stripTerminalSequences(this.getSelectionSourceLine(point));
		const segments: Array<{ start: number; end: number; selectable: boolean; joiner: boolean }> = [];
		let start = 0;
		for (const segment of wordSegmenter.segment(line)) {
			const end = start + visibleWidth(segment.segment);
			const joiner = TERMINAL_WORD_SELECTION_JOINERS.has(segment.segment);
			segments.push({ start, end, selectable: segment.isWordLike === true || joiner, joiner });
			start = end;
		}
		const clickedSegmentIndex = segments.findIndex(
			(segment) => point.col >= segment.start && point.col < segment.end,
		);
		if (clickedSegmentIndex < 0) return undefined;

		const canJoin = (
			left: { selectable: boolean; joiner: boolean },
			right: { selectable: boolean; joiner: boolean },
		): boolean => left.selectable && right.selectable && (left.joiner || right.joiner);
		let selectionStart = segments[clickedSegmentIndex].start;
		let selectionEnd = segments[clickedSegmentIndex].end;
		for (let index = clickedSegmentIndex; index > 0 && canJoin(segments[index - 1], segments[index]); index--) {
			selectionStart = segments[index - 1].start;
		}
		for (
			let index = clickedSegmentIndex;
			index < segments.length - 1 && canJoin(segments[index], segments[index + 1]);
			index++
		) {
			selectionEnd = segments[index + 1].end;
		}
		return {
			start: { ...point, col: selectionStart },
			end: { ...point, col: selectionEnd, boundary: true },
		};
	}

	private getLineSelection(point: SelectionPoint): SelectionRange {
		const line = this.getSelectionSourceLine(point);
		const bubble = bubbleTextColumns(line);
		const end = selectionLineEnd(line);
		if (bubble && bubble.end > bubble.start) {
			return {
				start: { ...point, col: bubble.start },
				end: { ...point, col: end, boundary: true },
			};
		}
		return {
			start: { ...point, col: 0 },
			end: { ...point, col: end, boundary: true },
		};
	}

	private updateSelectionFocus(point: SelectionPoint): void {
		if (this.selectionGranularity === "character" || !this.selectionInitialRange) {
			this.selectionFocus = point;
			return;
		}
		const range = this.selectionGranularity === "word" ? this.getWordSelection(point) : this.getLineSelection(point);
		if (!range) return;
		const initial = this.selectionInitialRange;
		const targetBeforeInitial =
			range.start.row < initial.start.row ||
			(range.start.row === initial.start.row && range.start.col < initial.start.col);
		if (targetBeforeInitial) {
			this.selectionAnchor = initial.end;
			this.selectionFocus = range.start;
		} else {
			this.selectionAnchor = initial.start;
			this.selectionFocus = range.end;
		}
	}

	private getClickCount(point: SelectionPoint, word: SelectionRange | undefined): number {
		const now = Date.now();
		const previous = this.lastClick;
		const count =
			word &&
			previous &&
			now - previous.timestamp <= DOUBLE_CLICK_INTERVAL_MS &&
			previous.row === point.row &&
			previous.scrollView === point.scrollView &&
			previous.wordStart === word.start.col &&
			previous.wordEnd === word.end.col
				? (previous.count % 3) + 1
				: 1;
		this.lastClick = word
			? {
					timestamp: now,
					count,
					row: point.row,
					scrollView: point.scrollView,
					wordStart: word.start.col,
					wordEnd: word.end.col,
				}
			: undefined;
		return count;
	}

	private updateSelectionAutoScroll(event: SgrMouseEvent): void {
		const scrollView = this.selectionAnchor?.scrollView;
		if (!scrollView || !this.currentLayout) {
			this.stopSelectionAutoScroll();
			return;
		}
		const box = getScrollViewBox(this.currentLayout, scrollView);
		if (!box || box.rect.height <= 0 || box.clip.height <= 0) {
			this.stopSelectionAutoScroll();
			return;
		}
		const visibleTop = Math.max(0, box.rect.y, box.clip.y);
		const visibleBottom = Math.min(
			this.terminal.rows - 1,
			box.rect.y + box.rect.height - 1,
			box.clip.y + box.clip.height - 1,
		);
		this.selectionDragPointer = { x: event.x, y: event.y };
		// 贴着视口第一行、最后一行拖，不能算移出。否则选区会自己窜到文档首尾。
		this.selectionAutoScrollDirection = selectionAutoScrollDirection(event.y, visibleTop, visibleBottom);
		if (this.selectionAutoScrollDirection === 0) {
			this.stopSelectionAutoScroll();
			return;
		}
		if (this.selectionAutoScrollTimer) return;
		this.selectionAutoScrollTimer = setInterval(() => this.autoScrollSelection(), 50);
		this.selectionAutoScrollTimer.unref();
	}

	private autoScrollSelection(): void {
		const scrollView = this.selectionAnchor?.scrollView;
		const pointer = this.selectionDragPointer;
		const direction = this.selectionAutoScrollDirection;
		if (!scrollView || !pointer || direction === 0) {
			this.stopSelectionAutoScroll();
			return;
		}
		const remaining = scrollView.scrollBy(direction);
		if (remaining === direction) {
			this.stopSelectionAutoScroll();
			return;
		}
		const raw = this.getScrollSelectionPoint(scrollView, pointer.x, pointer.y);
		const point = raw ? this.clampPointToBlock(raw) : undefined;
		if (point) this.updateSelectionFocus(point);
		this.requestViewportRender();
	}

	private stopSelectionAutoScroll(): void {
		if (this.selectionAutoScrollTimer) {
			clearInterval(this.selectionAutoScrollTimer);
			this.selectionAutoScrollTimer = undefined;
		}
		this.selectionAutoScrollDirection = 0;
		this.selectionDragPointer = undefined;
	}

	private handleSelectionMouseEvent(event: SgrMouseEvent): void {
		const button = event.button & 3;
		if (button !== 0 && !(event.release && button === 3)) return;
		const anchorScrollView = this.selectionAnchor?.scrollView;
		const point = this.clampPointToBlock(this.getSelectionPoint(event, anchorScrollView));
		if (event.release) {
			if (!this.selectionPressActive) return;
			this.selectionPressActive = false;
			this.stopSelectionAutoScroll();
			if (!this.selectionAnchor) return;
			this.updateSelectionFocus(point);
			// 与按下时的原始格比（±1 格容差），而不是被词吸附过的 anchor——
			// 否则双击落点在词中间时 anchor 停在词首，永远判成拖选，click 不合成。
			const pressCell = this.selectionPressCell;
			const isClick =
				!this.selectionDragged &&
				pressCell !== undefined &&
				pressCell.scrollView === point.scrollView &&
				Math.abs(pressCell.row - point.row) <= 1 &&
				Math.abs(pressCell.col - point.col) <= 1;
			const clickedUrl = isClick ? this.pressedUrl : undefined;
			this.pressedUrl = undefined;
			if (clickedUrl && this.openUrl) {
				this.selectionAnchor = undefined;
				this.selectionFocus = undefined;
				try {
					this.openUrl(clickedUrl);
				} catch {
					// URL activation is best-effort.
				}
				this.requestViewportRender();
				return;
			}
			if (isClick) {
				const clickEvent = this.createMouseEvent("click", event.button, event.x, event.y, {
					clickCount: this.lastClick?.count ?? 1,
				});
				const result = this.dispatchMouseClick(
					clickEvent,
					() => {
						const overlay = this.dispatchMouseToOverlay(clickEvent);
						return overlay.result ?? (overlay.hit ? undefined : this.dispatchMouseToLayout(clickEvent));
					},
				);
				if (result) {
					const render = this.applyMouseDispatchResult(clickEvent, result);
					this.clearTextSelection();
					if (render) this.requestViewportRender();
					return;
				}
			}
			this.requestViewportRender();
			return;
		}
		if ((event.button & 32) !== 0) {
			if (!this.selectionPressActive || !this.selectionAnchor) return;
			// ±1 格内的手抖不算拖选：原样等松开合成 click，双击的第二击才不会掉链子。
			const pressCell = this.selectionPressCell;
			if (
				pressCell !== undefined
				&& pressCell.scrollView === point.scrollView
				&& Math.abs(pressCell.row - point.row) <= 1
				&& Math.abs(pressCell.col - point.col) <= 1
			) {
				return;
			}
			this.selectionDragged = true;
			this.lastClick = undefined;
			this.pressedUrl = undefined;
			this.updateSelectionFocus(point);
			this.updateSelectionAutoScroll(event);
			this.requestViewportRender();
			return;
		}
		this.stopSelectionAutoScroll();
		// 有浮层在场时窗外的正文不参与选取：模态的语义就是「先处理这一层」。
		// 不挡的话，从窗外起手一直拖进弹窗，会把转录和弹窗混成一段拷走——读起来像对话框漏了底。
		// 非捕获浮层（toast 那类，目前无人使用）也在 overlayStack 里，会一并挡住选取；真要放开，
		// 判据要换成「存在可捕获的可见浮层」。
		const onOverlay = this.hasOverlay();
		const hit = onOverlay ? this.overlayRectAt(event.x, event.y) : undefined;
		if (onOverlay && hit === undefined) return;
		this.selectionPressActive = true;
		// 落点在浮层上就把选区锁进那块矩形（含「点了弹窗但没点在正文上」的空白处），
		// 并让开框线：拷的是内容，不是框。
		this.selectionRect = hit === undefined ? undefined : this.overlayContentRect(hit);
		const scrollView =
			!this.hasOverlay() && this.currentLayout
				? getScrollViewsAt(this.currentLayout, event.x, event.y)[0]
				: undefined;
		const anchor = this.getSelectionPoint(event, scrollView);
		// 工具详情的双击是收起，不在这里升级成选词/选行；拖选仍走字符粒度。
		const word = this.hitSuppressesMultiClickSelection(event.x, event.y)
			? undefined
			: this.getWordSelection(anchor);
		const clickCount = this.getClickCount(anchor, word);
		const range = clickCount === 2 ? word : clickCount === 3 ? this.getLineSelection(anchor) : undefined;
		this.selectionGranularity = range ? (clickCount === 2 ? "word" : "line") : "character";
		this.selectionInitialRange = range;
		this.selectionBlock = scrollView && this.currentLayout
			? selectionBlockRows(this.currentLayout, scrollView, event.y)
			: undefined;
		this.selectionAnchor = range?.start ?? anchor;
		// 记下按下的原始格：词吸附会把 anchor 顶到词首，松开时若仍拿 anchor 比，
		// 点在词中间的双击会被误判成拖选，click 不合成——工具行双击收起时好时坏的根源。
		this.selectionPressCell = { scrollView: anchor.scrollView, row: anchor.row, col: anchor.col };
		this.selectionFocus = range?.end ?? anchor;
		this.selectionDragged = false;
		this.pressedUrl = range
			? undefined
			: getOsc8LinkAtColumn(
					this.previousScreen[Math.max(0, Math.min(this.terminal.rows - 1, event.y))] ?? "",
					Math.max(0, Math.min(this.terminal.columns - 1, event.x)),
				);
		this.requestViewportRender();
	}

	private getSelectionBounds(): { start: SelectionPoint; end: SelectionPoint } | undefined {
		if (!this.selectionAnchor || !this.selectionFocus) return undefined;
		if (this.selectionAnchor.scrollView !== this.selectionFocus.scrollView) return undefined;
		const anchorBeforeFocus =
			this.selectionAnchor.row < this.selectionFocus.row ||
			(this.selectionAnchor.row === this.selectionFocus.row && this.selectionAnchor.col < this.selectionFocus.col);
		if (
			this.selectionAnchor.row === this.selectionFocus.row &&
			this.selectionAnchor.col === this.selectionFocus.col
		) {
			return undefined;
		}
		return anchorBeforeFocus
			? { start: this.selectionAnchor, end: this.selectionFocus }
			: { start: this.selectionFocus, end: this.selectionAnchor };
	}

	private getSelectionColumns(
		line: string,
		row: number,
		selection: { start: SelectionPoint; end: SelectionPoint },
		minColumn = 0,
		maxColumn = selectionLineEnd(line),
	): { start: number; end: number } {
		const bubble = bubbleTextColumns(line);
		// 范围拖选是文本流：第一行从按下处收到行尾，最后一行从行首收到松开处。
		const contentEnd = selectionLineEnd(line);
		const contentStart = bubble ? bubble.start : textStartColumn(line);
		const cap = Math.min(maxColumn, contentEnd);
		let start = Math.max(contentStart, minColumn);
		let end = cap;
		if (row === selection.start.row) {
			const at = getGraphemeCellRange(line, selection.start.col)?.start ?? Math.min(selection.start.col, contentEnd);
			start = Math.max(contentStart, minColumn, at);
		}
		if (row === selection.end.row) {
			if (selection.end.boundary) {
				end = Math.min(selection.end.col, contentEnd);
			} else {
				const range = getGraphemeCellRange(line, selection.end.col);
				// 指针在填充空格上时，这个空格的右缘不能把填充算进选区。
				end = !range || range.start >= contentEnd ? contentEnd : Math.min(range.end, contentEnd);
			}
		}
		end = Math.min(cap, end);
		if (end < start) end = start;
		return { start, end };
	}

	/** 终端焦点在不在这个窗口（1004 上报）。给完成提醒用：正盯着就别响。 */
	terminalFocused(): boolean {
		return this.terminalHasFocus;
	}

	/** 当前有没有选区。键盘复制据此决定是否消耗按键（见 interactive-mode 的 app.copy）。 */
	hasTextSelection(): boolean {
		return this.getSelectionBounds() !== undefined;
	}

	/**
	 * 复制当前选区。没有选区返回 undefined，调用方不报任何反馈——右键在无选区时不拦截，
	 * 终端自己的「复制/粘贴」语义才留得下来。
	 */
	async copyTextSelection(): Promise<ClipboardCopy | undefined> {
		const text = this.getActiveSelectionText();
		if (!text) return undefined;
		const result = this.copySelection ? await this.copySelection(text) : this.writeOsc52(text);
		this.copyFeedback(result);
		return result;
	}

	/** 兜底通路：把文本写给终端。是否真进了剪贴板无从确认，所以返回值是 `osc52` 而不是成功。 */
	private writeOsc52(text: string): ClipboardCopy {
		this.terminal.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
		return "osc52";
	}

	/** 复制反馈：只有原生通路退出码 0 才说 Copied!，OSC 52 如实标出通路，失败就说失败。 */
	private copyFeedback(result: ClipboardCopy): void {
		const message = result === "native" ? "Copied!" : result === "osc52" ? "Copied (OSC 52)" : "Copy failed";
		if (this.onCopyFeedback) {
			this.onCopyFeedback(message);
			return;
		}
		this.flash(message);
	}

	private getActiveSelectionText(): string | undefined {
		const selection = this.getSelectionBounds();
		if (!selection) return undefined;
		let sourceLines: readonly string[] = this.previousScreen;
		if (selection.start.scrollView) {
			if (!this.currentLayout) return undefined;
			const box = getScrollViewBox(this.currentLayout, selection.start.scrollView);
			if (!box?.scrollContentLines) return undefined;
			sourceLines = box.scrollContentLines;
		}
		const lines: string[] = [];
		for (let row = selection.start.row; row <= selection.end.row; row++) {
			const line = sourceLines[row] ?? "";
			const columns = this.getSelectionColumns(line, row, selection);
			lines.push(
				stripTerminalSequences(
					sliceByColumn(line, columns.start, Math.max(0, columns.end - columns.start), true),
				).trimEnd(),
			);
		}
		const text = lines.join("\n");
		return text.trim().length === 0 ? undefined : text;
	}

	/** 把一行的选区段染上高亮；无选区段或整行不在选区内时原样返回。 */
	private paintSelectionLine(
		line: string,
		row: number,
		selection: SelectionRange,
		minColumn = 0,
		maxColumn = this.terminal.columns,
	): string {
		const lineWidth = visibleWidth(line);
		const columns = this.getSelectionColumns(line, row, selection, minColumn, maxColumn);
		if (columns.end <= columns.start) return line;
		const before = sliceByColumn(line, 0, columns.start, true);
		const selected = sliceByColumn(line, columns.start, columns.end - columns.start, true);
		const after = sliceByColumn(line, columns.end, Math.max(0, lineWidth - columns.end), true);
		return `${before}${applySelectionHighlight(selected, this.selectionStyle)}${after}`;
	}

	/**
	 * 浮层内那一块的选区高亮：正文那趟染色发生在浮层合成**之前**，对话框会把它整个盖掉，
	 * 于是弹窗里拖选手感有、颜色没有。这里在合成之后、按浮层实际占的屏幕行补一次同一套染法。
	 *
	 * 只补屏幕缓冲（非 scrollView）的选区——弹窗内的选区正是这一种：滚动内容按源码行选，
	 * 而弹窗自己的滚动区不参与布局命中，隐藏行本来就不在可选范围内。
	 */
	private applyOverlaySelection(screen: string[]): string[] {
		const selection = this.getSelectionBounds();
		if (!selection || selection.start.scrollView) return screen;
		const rects = this.renderedOverlayRects();
		if (rects.length === 0) return screen;
		const clamp = this.selectionClamp();
		const result = [...screen];
		for (let row = selection.start.row; row <= Math.min(selection.end.row, result.length - 1); row++) {
			if (!rects.some((rect) => row >= rect.row && row < rect.row + rect.height)) continue;
			result[row] = this.paintSelectionLine(
				result[row] ?? "",
				row,
				selection,
				clamp?.minColumn ?? 0,
				clamp?.maxColumn ?? this.terminal.columns,
			);
		}
		return result;
	}

	private applySelection(screen: string[], layout = this.currentLayout): string[] {
		const selection = this.getSelectionBounds();
		if (!selection) return screen;
		let screenSelection = selection;
		let minRow = 0;
		let maxRow = screen.length - 1;
		let minColumn = 0;
		let maxColumn = this.terminal.columns;
		if (selection.start.scrollView) {
			if (!layout) return screen;
			const box = getScrollViewBox(layout, selection.start.scrollView);
			if (!box) return screen;
			minRow = Math.max(0, box.rect.y, box.clip.y);
			maxRow = Math.min(screen.length - 1, box.rect.y + box.rect.height - 1, box.clip.y + box.clip.height - 1);
			minColumn = Math.max(0, box.rect.x, box.clip.x);
			maxColumn = Math.min(this.terminal.columns, box.rect.x + box.rect.width, box.clip.x + box.clip.width);
			screenSelection = {
				start: {
					...selection.start,
					row: box.rect.y + selection.start.row - selection.start.scrollView.scrollTop,
					col: box.rect.x + selection.start.col,
				},
				end: {
					...selection.end,
					row: box.rect.y + selection.end.row - selection.start.scrollView.scrollTop,
					col: box.rect.x + selection.end.col,
				},
			};
		} else {
			// 浮层选区：床底转录左右两侧那一块不该跟着染色——选区在窗里，窗外的底色是别人的。
			const clamp = this.selectionClamp();
			if (clamp) {
				minRow = clamp.minRow;
				maxRow = Math.min(maxRow, clamp.maxRow);
				minColumn = clamp.minColumn;
				maxColumn = clamp.maxColumn;
			}
		}
		return screen.map((line, row) => {
			if (
				row < minRow ||
				row > maxRow ||
				row < screenSelection.start.row ||
				row > screenSelection.end.row
			) {
				return line;
			}
			return this.paintSelectionLine(line, row, screenSelection, minColumn, maxColumn);
		});
	}

	private isMouseSequence(data: string): boolean {
		return /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data) || (data.length === 6 && data.startsWith("\x1b[M"));
	}

	private compositeScrollToEndIndicator(screen: string[], layout: LayoutFrame, width: number): string[] {
		this.scrollToEndIndicatorRect = undefined;
		const scrollView = layout.primaryScrollView ?? this.implicitScrollView;
		if (!this.scrollToEndIndicator || !scrollView.followEnd || scrollView.isFollowingEnd) return screen;
		const box = getScrollViewBox(layout, scrollView);
		const clip = box?.clip;
		if (!box || !clip || clip.width <= 0 || clip.height <= 0) return screen;
		const row = clip.y + clip.height - 1;
		if (row >= screen.length) return screen;
		const availableWidth = Math.max(0, contentPaintRight(box) - clip.x);
		const text = truncateToWidth(this.scrollToEndIndicator(), availableWidth, "");
		const textWidth = visibleWidth(text);
		if (textWidth === 0) return screen;
		const column = clip.x + Math.floor((availableWidth - textWidth) / 2);
		const result = [...screen];
		result[row] = compositeTuiLine(result[row] ?? "", text, column, textWidth, width);
		this.scrollToEndIndicatorRect = { row, column, width: textWidth };
		return result;
	}

	private compositeFlashes(screen: string[], width: number, height: number): string[] {
		const flashLines = this.flashes.render(width).slice(-height);
		if (flashLines.length === 0) return screen;
		const result = [...screen];
		while (result.length < height) result.push("");
		for (let row = 0; row < flashLines.length; row++) {
			const line = flashLines[row]!;
			const flashWidth = visibleWidth(line);
			if (flashWidth === 0) continue;
			result[row] = compositeTuiLine(result[row] ?? "", line, width - flashWidth, flashWidth, width);
		}
		return result;
	}

	protected override doRender(): void {
		if (this.stopped || !this.altScreenActive) return;
		const width = Math.max(1, this.terminal.columns);
		const height = Math.max(1, this.terminal.rows);
		const root = this.layoutRoot ?? this.implicitScrollView;
		const nextLayout = renderLayoutFrame(
			root,
			width,
			height,
			() => this.requestViewportRender(),
			this.contentGeneration,
		);
		let screen = nextLayout.lines.map((line) => line.replace(OSC133_ZONE_PREFIX, ""));
		// 叠层从底到顶：layout 正文（含滚动条）已经在 nextLayout.lines 里。
		// 内容装饰不得盖住视口 chrome / 浮层 / flash，否则选区会染上对话框、│ 会穿出吸顶气泡。
		screen = this.applySelection(screen, nextLayout);
		screen = this.chrome?.composite(screen, nextLayout, width) ?? screen;
		screen = this.compositeScrollToEndIndicator(screen, nextLayout, width);
		// 吸顶与正文气泡同宽，滑块最后盖回右缘，避免气泡短一列、滑块被灰底吃掉。
		screen = compositeScrollbars(screen, nextLayout, width);
		if (screen.length > height) screen = screen.slice(screen.length - height);
		// 短暂提示盖住正文与滚动条，但不能遮挡需要用户响应的模态对话框。
		screen = this.compositeFlashes(screen, width, height);
		screen = this.compositeOverlays(screen, width, height);
		if (screen.length > height) screen = screen.slice(screen.length - height);
		// 浮层内的拖选在这一步才染：早于合成的高亮会被浮层自己盖掉。
		screen = this.applyOverlaySelection(screen);

		const cursorPos = this.extractCursorPosition(screen, height);
		screen = this.applyLineResets(screen).map((line) => clipLineToWidth(line, width));

		const painted = paintScreenDiff({
			screen,
			previous: this.previousScreen,
			previousWidth: this.previousScreenWidth,
			previousHeight: this.previousScreenHeight,
			width,
			height,
			cursor: cursorPos,
			showHardwareCursor: this.getShowHardwareCursor(),
			// 浮层在场时不许用终端滚动区挪像素：对话框的边框与内边距不跟正文走。
			hasOverlay: this.hasOverlay(),
		});
		if (painted.fullRedraw) this.fullRedrawCount += 1;
		this.terminal.write(painted.buffer);

		this.previousScreen = screen;
		this.previousScreenWidth = width;
		this.previousScreenHeight = height;
		this.currentLayout = nextLayout;
	}
}
