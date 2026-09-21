import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SelectItem, SelectListTheme } from '../../../src/tui/components/select-list.js';
import { SelectList } from '../../../src/tui/components/select-list.js';
import type { TuiMouseEvent } from '../../../src/tui/core/tui.js';

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
		if (line.startsWith('❙ ')) return line.slice(2).trim().split(/\s{2,}/)[0];
	}
	return undefined;
}

describe('SelectList 的滚轮', () => {
	it('向下滚轮改高亮，不确认', () => {
		const l = list();
		let confirmed = 0;
		l.onSelect = () => {
			confirmed++;
		};
		l.handleMouse(wheel(1));
		assert.equal(selectedValue(l), 'item-1');
		assert.equal(confirmed, 0);
	});

	it('向上滚轮改高亮', () => {
		const l = list();
		l.setSelectedIndex(2);
		l.handleMouse(wheel(-1));
		assert.equal(selectedValue(l), 'item-1');
	});

	it('滚到边界后停住，不回卷', () => {
		const l = list();
		for (let i = 0; i < 10; i++) l.handleMouse(wheel(1));
		assert.equal(selectedValue(l), 'item-4');
		for (let i = 0; i < 10; i++) l.handleMouse(wheel(-1));
		assert.equal(selectedValue(l), 'item-0');
	});

	it('滚轮被吞掉；有变化才重绘，不会穿透到弹窗背后的转录', () => {
		const l = list();
		const moved = l.handleMouse(wheel(1));
		assert.equal(moved?.handled, true, '必须吞掉滚轮，否则背后的转录会跟着滚');
		assert.equal(moved?.render, true);
		const atEnd = list();
		atEnd.setSelectedIndex(4);
		const stuck = atEnd.handleMouse(wheel(1));
		assert.equal(stuck?.handled, true);
		assert.equal(stuck?.render, false, '没有变化就不该为一次滚轮白重绘一帧');
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

	it('点击只高亮，不确认', () => {
		const l = list();
		let confirmed: string | undefined;
		l.onSelect = (item) => {
			confirmed = item.value;
		};
		// 选中项在中间时可视区是 item-1..item-3（以选中项为中心），第 0 行即 item-1。
		l.setSelectedIndex(2);
		l.handleMouse({ ...wheel(0), type: 'press', button: 'left', y: 0 });
		l.handleMouse({ ...wheel(0), type: 'click', button: 'left', y: 0 });
		assert.equal(selectedValue(l), 'item-1');
		assert.equal(confirmed, undefined);
	});

	it('回车才确认当前高亮项', () => {
		const l = list();
		let confirmed: string | undefined;
		l.onSelect = (item) => {
			confirmed = item.value;
		};
		l.setSelectedIndex(2);
		l.handleInput('\r');
		assert.equal(confirmed, 'v2');
	});

	it('移动鼠标不改选中项（hover 不选中）', () => {
		const l = list();
		const before = selectedValue(l);
		l.handleMouse({ ...wheel(0), type: 'move', button: 'left', y: 2 });
		assert.equal(selectedValue(l), before);
	});
});
