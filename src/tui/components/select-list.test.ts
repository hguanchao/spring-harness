import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SelectItem, SelectListTheme } from './select-list.js';
import { SelectList } from './select-list.js';
import type { TuiMouseEvent } from '../core/tui.js';

const UP = '\x1b[A';
const DOWN = '\x1b[B';

/** 纯文本主题：测试只关心选中项与事件结果，不关心颜色。 */
const theme: SelectListTheme = {
	description: (t) => t,
	scrollInfo: (t) => t,
	noMatch: (t) => t,
	selectedMark: (t) => t,
	selectedRow: (t) => t,
};

function items(count: number): SelectItem[] {
	return Array.from({ length: count }, (_, i) => ({ value: `v${i}`, label: `item-${i}` }));
}

function list(count = 5, maxVisible = 3): SelectList {
	return new SelectList(items(count), maxVisible, theme);
}

function wheel(delta: number, y = 0): TuiMouseEvent {
	return {
		type: 'wheel',
		button: 'none',
		x: 0,
		y,
		screenX: 0,
		screenY: y,
		width: 20,
		height: 3,
		shift: false,
		alt: false,
		ctrl: false,
		wheelDelta: delta,
	};
}

/** 选中行在渲染结果里带 selectedMark 前缀，据此反查当前选中项。 */
function selectedValue(list: SelectList, width = 40): string | undefined {
	for (const line of list.render(width)) {
		if (line.startsWith('│ ')) return line.slice(2).trim().split(/\s{2,}/)[0];
	}
	return undefined;
}

describe('SelectList 的滚轮', () => {
	it('向下滚轮不改选中项', () => {
		const l = list();
		const before = selectedValue(l);
		l.handleMouse(wheel(1));
		assert.equal(selectedValue(l), before);
	});

	it('向上滚轮不改选中项', () => {
		const l = list();
		l.setSelectedIndex(2);
		const before = selectedValue(l);
		l.handleMouse(wheel(-1));
		assert.equal(selectedValue(l), before);
	});

	it('连续滚轮多次也不改选中项', () => {
		const l = list();
		const before = selectedValue(l);
		for (let i = 0; i < 10; i++) l.handleMouse(wheel(1));
		for (let i = 0; i < 10; i++) l.handleMouse(wheel(-1));
		assert.equal(selectedValue(l), before);
	});

	it('滚轮被吞掉且声明无需重绘，不会穿透到弹窗背后的转录', () => {
		const l = list();
		const result = l.handleMouse(wheel(1));
		assert.equal(result?.handled, true, '必须吞掉滚轮，否则背后的转录会跟着滚');
		assert.equal(result?.render, false, '没有变化就不该为一次滚轮白重绘一帧');
	});

	it('空列表的滚轮交回上层', () => {
		const l = list(0);
		assert.equal(l.handleMouse(wheel(1)), undefined);
	});
});

describe('SelectList 的键盘与点击', () => {
	it('下键改选中项', () => {
		const l = list();
		assert.equal(selectedValue(l), 'item-0');
		l.handleInput(DOWN);
		assert.equal(selectedValue(l), 'item-1');
	});

	it('上键改选中项，并在首项回卷到末项', () => {
		const l = list();
		l.handleInput(UP);
		assert.equal(selectedValue(l), 'item-4');
		l.handleInput(DOWN);
		assert.equal(selectedValue(l), 'item-0');
	});

	it('点击仍然选中（鼠标的明确意图保留）', () => {
		const l = list();
		// 选中项在中间时可视区是 item-1..item-3（以选中项为中心），第 0 行即 item-1。
		l.setSelectedIndex(2);
		l.handleMouse({ ...wheel(0), type: 'press', button: 'left', y: 0 });
		assert.equal(selectedValue(l), 'item-1');
	});

	it('移动鼠标不改选中项（hover 不选中）', () => {
		const l = list();
		const before = selectedValue(l);
		l.handleMouse({ ...wheel(0), type: 'move', button: 'left', y: 2 });
		assert.equal(selectedValue(l), before);
	});
});
