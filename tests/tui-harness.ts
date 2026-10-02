/**
 * TUI 的测试地基：假终端 + 同步出帧。
 *
 * 为什么帧测试值得单独搭一层：控件单测断言的是 `render(width)` 的字符串，而那些字符串
 * 都是对的时，界面照样可以是坏的——坐标、层叠顺序、事件路由、重绘时机全在**接线**上。
 * 看提交记录就知道这类 bug 有多少：浮层按绝对列定位、工具行的选中标记被读成行前缀、
 * 点在工具行以外要取消选中、双击详情不再选词。每一条都是「零件对、拼起来错」，
 * 控件单测永远抓不到，只能靠人眼发现，修完也没有东西阻止它回来。
 *
 * 这里不模拟 ANSI：`TuiAltScreen.frame()` 给的就是合成后的每一行，那是用户真正看到的东西。
 * 差分字节流是另一层，由 `paintScreenDiff` 的纯函数用例单独覆盖。
 *
 * **不需要注入时钟**。渲染走 `renderNow()`——它同步执行、不挂定时器，把节流那一段整个
 * 绕过。这正是当初渲染链用例整批挂死的病根所在：等节流后的帧，就只能等真实时间，而
 * `setTimeout(0)` 在 Windows 上可能要 16ms 一个 tick，几十个用例堆起来就是「跑不动」。
 * 断言「这一帧长什么样」时不必等节流，那是给动画用的。
 */

import type { Terminal } from '@/tui/terminal/terminal.js';
import { TuiAltScreen, type TuiAltScreenOptions } from '@/tui/screen/tui-alt-screen.js';

/**
 * 假终端：把终端交互缩成「收下输入回调、记下输出」。
 *
 * 只实现 `Terminal` 接口里 TUI 真正会用到的那几个成员：光标与清屏等操作记成事件序列，
 * 供需要断言「到底有没有清屏」的用例查，但默认不参与渲染结果。
 */
export class FakeTerminal implements Terminal {
	columns: number;
	rows: number;
	/** 每次 `write` 的输出，按序拼接。查「有没有画出去」用。 */
	readonly output: string[] = [];
	/** 光标/清屏等操作名，按序。 */
	readonly operations: string[] = [];
	kittyProtocolActive = false;

	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;

	constructor(columns = 100, rows = 30) {
		this.columns = columns;
		this.rows = rows;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
	}

	stop(): void {
		this.inputHandler = undefined;
		this.resizeHandler = undefined;
	}

	async drainInput(): Promise<void> {
		/* 没有真实 stdin，无事可做 */
	}

	write(data: string): void {
		this.output.push(data);
	}

	/** 灌一个按键序列进去，走的与真实终端同一条路。 */
	send(data: string): void {
		this.inputHandler?.(data);
	}

	/** 改窗口尺寸并通知，用于断言「窄终端下的退化」。 */
	resize(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
		this.resizeHandler?.();
	}

	/** 全部输出拼起来，方便 include 断言。 */
	text(): string {
		return this.output.join('');
	}

	moveBy(lines: number): void {
		this.operations.push(`moveBy:${lines}`);
	}

	hideCursor(): void {
		this.operations.push('hideCursor');
	}

	showCursor(): void {
		this.operations.push('showCursor');
	}

	clearLine(): void {
		this.operations.push('clearLine');
	}

	clearFromCursor(): void {
		this.operations.push('clearFromCursor');
	}

	clearScreen(): void {
		this.operations.push('clearScreen');
	}

	setTitle(): void {
		/* 标题不影响帧 */
	}

	setProgress(): void {
		/* 进度条不影响帧 */
	}
}

/** 一块按固定文本渲染的组件，用来给帧测试当底稿。 */
export function textBlock(...lines: string[]): { render(width: number): string[]; invalidate(): void } {
	return {
		render: () => [...lines],
		invalidate: () => {},
	};
}

export interface MountedTui {
	tui: TuiAltScreen;
	terminal: FakeTerminal;
	/** 同步出帧并返回合成后的每一行。 */
	frame(): readonly string[];
	/** 灌输入，随后同步出帧。 */
	type(data: string): readonly string[];
	/** 收尾。用例结束前调一次即可（不调也不会污染后续用例）。 */
	dispose(): void;
}

/**
 * 挂一块底稿、起一屏，返回可以直接断言的句柄。
 *
 * 全程走 `renderNow(true)`，不经过节流：`requestRender(force)` 会清掉排队中的渲染与定时器，
 * 所以 `start()` 里排的那次异步渲染落地时看到 `renderRequested === false` 就自行退出了，
 * 不会在断言之后再写一帧。
 */
export function mountTui(options: {
	width?: number;
	height?: number;
	root: { render(width: number): string[]; invalidate(): void };
	altScreen?: TuiAltScreenOptions;
}): MountedTui {
	const terminal = new FakeTerminal(options.width ?? 100, options.height ?? 30);
	const tui = new TuiAltScreen(terminal, false, undefined, options.altScreen ?? {});
	tui.start();
	tui.setLayoutRoot(options.root);
	tui.renderNow(true);
	return {
		tui,
		terminal,
		frame: () => {
			tui.renderNow(true);
			return tui.frame();
		},
		type: (data) => {
			terminal.send(data);
			tui.renderNow(true);
			return tui.frame();
		},
		dispose: () => tui.stop(),
	};
}

/** 去掉 SGR / OSC 等转义序列，只留可见字符。 */
export function stripAnsi(line: string): string {
	return line
		.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
		.replace(/\x1b[@-Z\\-_]|\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

/** 一屏的纯文本，按行给出来。断言内容用。 */
export function plainLines(frame: readonly string[]): string[] {
	return frame.map(stripAnsi);
}
