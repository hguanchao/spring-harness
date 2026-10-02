/**
 * 分组列表的开合手势：**双击**才激活，单击只移高亮（与工具行、工具组同一套）。
 *
 * Enter 不在这里测——双击是鼠标专属，键盘那条路在报告弹窗里（见 report/dialog.ts）。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GroupList, type GroupListTheme, type GroupRow } from '@/tui/widgets/group-list.js';

const theme: GroupListTheme = {
	selectedBg: (text) => text,
	hoverBg: (text) => text,
	fold: (text) => text,
};

const rows: GroupRow[] = [
	{ key: 'g', kind: 'group', text: 'Group', foldable: true },
	{ key: 'i', kind: 'item', text: 'Item', indent: 1, expandable: true },
];

const base = {
	button: 'left' as const,
	x: 0,
	screenX: 0,
	screenY: 0,
	width: 40,
	height: 2,
	shift: false,
	alt: false,
	ctrl: false,
};

/** 一次完整的「按下 + 松开」——合成 click 才进激活判定。 */
const clickOn = (y: number) => [
	{ ...base, type: 'press' as const, y },
	{ ...base, type: 'click' as const, y },
];

const activatedKeys = (): { list: GroupList; keys: string[] } => {
	const list = new GroupList(rows, theme, 10);
	const keys: string[] = [];
	list.onActivate = (row) => keys.push(row.key);
	return { list, keys };
};

describe('group list fold gesture', () => {
	it('activates on the second click, not the first', () => {
		const { list, keys } = activatedKeys();
		for (const event of clickOn(0)) list.handleMouse(event);
		assert.deepEqual(keys, [], '单击只把高亮移过来');
		for (const event of clickOn(0)) list.handleMouse(event);
		assert.deepEqual(keys, ['g'], '双击才开合');
	});

	it('does not count clicks on two different rows as a double click', () => {
		// y 是离散行号：相邻两行各点一下是「选了一条又选一条」，不是双击。
		const { list, keys } = activatedKeys();
		for (const event of clickOn(0)) list.handleMouse(event);
		for (const event of clickOn(1)) list.handleMouse(event);
		assert.deepEqual(keys, []);
	});

	it('still moves the highlight on a single click', () => {
		const { list } = activatedKeys();
		for (const event of clickOn(1)) list.handleMouse(event);
		assert.equal(list.selectedRow()?.key, 'i');
	});
});
