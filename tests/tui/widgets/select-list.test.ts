import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SelectItem, SelectListTheme } from '@/tui/widgets/select-list.js';
import { SelectList } from '@/tui/widgets/select-list.js';
import type { TuiMouseEvent } from '@/tui/screen/tui.js';
import { visibleWidth } from '@/tui/text/utils.js';

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
		if (line.startsWith('> ')) return line.slice(2).trim().split(/\s{2,}/)[0];
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

	it('过滤按 value 前缀，空结果给出 No matches，Esc 取消', () => {
		const l = list();
		const lines: string[] = [];
		l.onCancel = () => {
			lines.push('cancel');
		};
		l.setFilter('v1');
		assert.equal(selectedValue(l), 'item-1');
		l.setFilter('nope');
		assert.equal(l.itemCount, 0);
		assert.ok(l.render(40).some((line) => line.includes('No matches')));
		l.handleInput('\x1b');
		assert.deepEqual(lines, ['cancel']);
	});

	it('移动鼠标不改选中项（hover 不选中）', () => {
		const l = list();
		const before = selectedValue(l);
		l.handleMouse({ ...wheel(0), type: 'move', button: 'left', y: 2 });
		assert.equal(selectedValue(l), before);
	});
});

describe('SelectList 的分组标题', () => {
	const grouped = (): SelectList =>
		new SelectList(
			[
				{ value: 'header', label: 'Group', kind: 'header' },
				{ value: 'v0', label: 'item-0' },
			],
			2,
			theme,
		);

	it('标签嵌在横线里，且与 markdown 的 h3 用同一套线条字形', () => {
		const line = grouped().render(20)[0] ?? '';
		assert.match(line, /^─ Group ─+$/);
		assert.equal(line.includes('—'), false, '线条里不出现长破折号');
		assert.equal(visibleWidth(line), 20, '占满整宽');
	});

	it('标签比内容还宽时截到整宽，不撑破边框', () => {
		const l = new SelectList(
			[
				{ value: 'header', label: 'Plugins & Skills', kind: 'header' },
				{ value: 'v0', label: 'item-0' },
			],
			2,
			theme,
		);
		const line = l.render(12)[0] ?? '';
		assert.ok(visibleWidth(line) <= 12, `标题行不该超出内容宽，实际 ${visibleWidth(line)}`);
	});
});

describe('行号槽', () => {
	function rendered(source: SelectItem[], maxVisible: number, width: number, numbered: boolean): string[] {
		const list = new SelectList(source, maxVisible, theme, { numbered, minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 12 });
		list.renderScrollInfoLine = false;
		return list.render(width).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''));
	}

	it('关掉时行首仍是原来的选中条', () => {
		const lines = rendered([{ value: 'a', label: 'alpha' }], 3, 40, false);
		assert.equal(lines[0], '> alpha', '未开号：一个字节都不多');
	});

	it('号接在选中条后面：`>` 永远占最外一格', () => {
		const lines = rendered([{ value: 'a', label: 'alpha' }, { value: 'b', label: 'beta' }], 3, 40, true);
		assert.equal(lines[0]?.startsWith('> 1 '), true, '选中行的号不越位');
		assert.equal(lines[1]?.startsWith('  2 '), true, '未选中行只是没有竖条');
	});

	it('号列宽按整表算，滚过 9→10 不把正文往右推', () => {
		const lines = rendered(items(12), 3, 40, true);
		const first = lines[0] ?? '';
		const second = lines[1] ?? '';
		assert.equal(first.slice(0, 5), '>  1 ', '个位数左补空格，不补零');
		assert.equal(second.slice(0, 5), '   2 ', '补零会让它看起来像 ID');
		assert.equal(first.indexOf('item-'), second.indexOf('item-'), '正文列在两行之间不抖');
	});

	it('非可选行不占号，但仍对齐到同一列', () => {
		const source: SelectItem[] = [
			{ value: 'h', label: 'Group', kind: 'header' },
			{ value: 'a', label: 'alpha' },
			{ value: 'd', label: 'note', kind: 'doc' },
			{ value: 'b', label: 'beta' },
		];
		const lines = rendered(source, 5, 40, true);
		const alpha = lines.find((line) => line.includes('alpha')) ?? '';
		const note = lines.find((line) => line.includes('note')) ?? '';
		const beta = lines.find((line) => line.includes('beta')) ?? '';
		assert.equal(alpha.indexOf('alpha'), note.indexOf('note'), '说明行跟可选行同列');
		assert.equal(beta.indexOf('beta'), alpha.indexOf('alpha'));
		assert.equal(alpha.indexOf('alpha'), beta.indexOf('beta'));
		assert.ok(alpha.includes(' 1 '));
		assert.ok(beta.includes(' 2 '), '头与说明行不占号：beta 是第 2 条');
	});

	it('底边框位置读数换成 n/m（不再套括号）', () => {
		const list = new SelectList(items(30), 5, theme);
		assert.equal(list.getScrollInfo(), '1/30');
	});
});
