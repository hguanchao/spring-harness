/**
 * 无头帧测试：整屏挂起来，断言用户真正看到的那一屏。
 *
 * 与 `tests/tui/widgets/*` 的分工：那边断言 `render(width)` 的字符串，是**零件**；
 * 这边断言合成之后的整屏，是**接线**。坐标、层叠、事件路由、重绘时机全都只在接线这一层
 * 才成立——零件的字符串全对而界面照样坏，是这类 bug 的常态。
 *
 * 不等待节流：全程 `renderNow(true)`。等节流后的帧就只能等真实时间，那正是当初渲染链
 * 用例整批挂死的原因（见 tests/tui-harness.ts 的说明）。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Component } from '@/tui/screen/tui.js';
import { visibleWidth } from '@/tui/text/utils.js';
import { mountTui, plainLines, stripAnsi, textBlock } from '../../tui-harness.js';

/** 可编辑组件：把收到的按键累积起来并渲染出来，用来验证输入路由。 */
function editable(initial = ''): Component & { text: string } {
	let text = initial;
	return {
		get text() {
			return text;
		},
		set text(next: string) {
			text = next;
		},
		render: () => [text],
		handleInput(data: string) {
			text += data;
		},
		invalidate() {},
	};
}

describe('headless frame', () => {
	it('fills the screen to exactly the terminal height', () => {
		const handle = mountTui({ width: 40, height: 12, root: textBlock('hello', 'world') });
		try {
			assert.equal(handle.frame().length, 12, '帧的行数必须等于终端高度，多一行就滚屏');
		} finally {
			handle.dispose();
		}
	});

	it('never emits a line wider than the terminal', () => {
		// 超出宽度的行会被终端折行，把下面所有行的布局整体推下去——这是最伤的一类渲染 bug，
		// 而且在宽终端上看不出来，只有窄终端才现形。
		const handle = mountTui({ width: 30, height: 8, root: textBlock('x'.repeat(200), 'ok') });
		try {
			for (const [row, line] of plainLines(handle.frame()).entries()) {
				assert.ok(
					visibleWidth(line) <= 30,
					`第 ${row} 行宽 ${visibleWidth(line)}，超过终端宽度 30`,
				);
			}
		} finally {
			handle.dispose();
		}
	});

	it('keeps the frame within the new width after a resize', () => {
		const handle = mountTui({ width: 60, height: 10, root: textBlock('y'.repeat(120)) });
		try {
			handle.terminal.resize(24, 6);
			const frame = plainLines(handle.frame());
			assert.equal(frame.length, 6, '高度跟随重设后的终端');
			for (const line of frame) assert.ok(visibleWidth(line) <= 24, `折行前必须重新夹宽度`);
		} finally {
			handle.dispose();
		}
	});

	it('routes input to the focused component and shows the result in the frame', () => {
		const field = editable();
		const handle = mountTui({ width: 40, height: 6, root: field });
		try {
			handle.tui.setFocus(field);
			handle.type('a');
			handle.type('b');
			assert.ok(
				plainLines(handle.frame()).some((line) => line.includes('ab')),
				'按键必须落到聚焦组件上，并反映到下一帧',
			);
		} finally {
			handle.dispose();
		}
	});

	it('does not route input when nothing is focused', () => {
		const field = editable('untouched');
		const handle = mountTui({ width: 40, height: 6, root: field });
		try {
			handle.type('zzz');
			assert.ok(
				plainLines(handle.frame()).some((line) => line.includes('untouched')),
				'没有焦点时按键不该落到任何组件上',
			);
		} finally {
			handle.dispose();
		}
	});
});

describe('overlay compositing', () => {
	it('paints the overlay at the absolute column its anchor resolves to', () => {
		// 40 列、宽 10 的居中浮层：起点列 = (40 − 10) / 2 = 15。位置错一列整块框就歪，
		// 而这正是「浮层按绝对列定位」那次修复要钉住的东西。
		const handle = mountTui({ width: 40, height: 12, root: textBlock('underlay') });
		try {
			handle.tui.showOverlay(textBlock('BOX'), { width: 10, anchor: 'center', priority: 1 });
			const frame = plainLines(handle.frame());
			const row = frame.findIndex((line) => line.includes('BOX'));
			assert.ok(row >= 0, '浮层内容必须出现在帧里');
			assert.equal(frame[row]!.indexOf('BOX'), 15, '浮层起点列由锚点算出，不是靠左拼上去的');
		} finally {
			handle.dispose();
		}
	});

	it('covers what is underneath instead of interleaving with it', () => {
		// 底稿在浮层区间内必须是**消失**，不是被插在前面或被穿透——「看着像抠掉一块」
		// 那类观感问题全在这一条上。
		const wide = textBlock('A'.repeat(40));
		const handle = mountTui({ width: 40, height: 10, root: wide });
		try {
			handle.tui.showOverlay(textBlock('#####'), { width: 12, anchor: 'center', priority: 1 });
			const row = plainLines(handle.frame()).findIndex((line) => line.includes('#####'));
			const painted = plainLines(handle.frame())[row]!;
			const overlayStart = painted.indexOf('#####');
			assert.ok(overlayStart >= 0);
			const covered = painted.slice(overlayStart, overlayStart + 12);
			assert.ok(!covered.includes('A'), `浮层区间里不该露出底稿：${JSON.stringify(covered)}`);
		} finally {
			handle.dispose();
		}
	});

	it('restores the underlay once the overlay is hidden', () => {
		const handle = mountTui({ width: 40, height: 10, root: textBlock('B'.repeat(40)) });
		try {
			const overlay = handle.tui.showOverlay(textBlock('#####'), { width: 12, anchor: 'center', priority: 1 });
			assert.ok(plainLines(handle.frame()).some((line) => line.includes('#####')));
			overlay.hide();
			const after = plainLines(handle.frame());
			assert.ok(!after.some((line) => line.includes('#####')), '关掉之后不该还留在帧上');
			assert.ok(after.some((line) => line.includes('B'.repeat(40))), '底稿必须原样回来');
		} finally {
			handle.dispose();
		}
	});

	it('composites two overlays bottom-to-top by priority', () => {
		// 更高优先级的浮层盖在上面那一层，而不是被它盖住。
		const handle = mountTui({ width: 40, height: 12, root: textBlock('base') });
		try {
			handle.tui.showOverlay(textBlock('LOW'), { width: 12, anchor: 'center', priority: 1 });
			handle.tui.showOverlay(textBlock('HIGH'), { width: 12, anchor: 'center', priority: 5 });
			const frame = plainLines(handle.frame());
			assert.ok(frame.some((line) => line.includes('HIGH')), '高优先级浮层必须在帧里');
			assert.ok(!frame.some((line) => line.includes('LOW')), '被盖住的低优先级内容不该穿透出来');
		} finally {
			handle.dispose();
		}
	});
});

describe('frame output encoding', () => {
	it('writes the painted frame to the terminal', () => {
		// 帧是对的但没写出去，也是坏——真实故障里「内容算了但没上屏」并不少见。
		const handle = mountTui({ width: 20, height: 4, root: textBlock('visible') });
		try {
			handle.frame();
			assert.ok(stripAnsi(handle.terminal.text()).includes('visible'), '合成结果必须写到终端');
		} finally {
			handle.dispose();
		}
	});
});
