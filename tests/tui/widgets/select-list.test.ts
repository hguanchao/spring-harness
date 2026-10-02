import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SelectList, type SelectListTheme } from '@/tui/widgets/select-list.js';

const theme: SelectListTheme = {
  description: (text) => text,
  scrollInfo: (text) => text,
  noMatch: (text) => text,
  selectedMark: (text) => text,
  selectedRow: (text) => text,
  currentMark: (text) => text,
};

describe('inline menu list styling', () => {
  it('renders group counts and a right-aligned current check', () => {
    const list = new SelectList(
      [
        { value: 'provider', label: 'opencode', kind: 'header', countNoun: 'models' },
        { value: 'one', label: 'MiMo-V2.6-Flash', description: 'mimo-v2.6-flash-free', current: true },
        { value: 'two', label: 'MiMo-V2.6', description: 'mimo-v2.6' },
      ],
      10,
      theme,
      { minPrimaryColumnWidth: 20, maxPrimaryColumnWidth: 20 },
    );
    const rows = list.render(60);
    assert.match(rows[0] ?? '', /✦ opencode \(2 models\)/);
    assert.match(rows[1] ?? '', /MiMo-V2\.6-Flash/);
    assert.match(rows[1] ?? '', /✓/);
    assert.doesNotMatch(rows[1] ?? '', /current/);
  });

  it('keeps headers out of selection navigation', () => {
    const list = new SelectList(
      [
        { value: 'header', label: 'Providers', kind: 'header', countNoun: 'providers' },
        { value: 'one', label: 'opencode' },
        { value: 'two', label: 'anthropic' },
      ],
      10,
      theme,
    );
    let selected: string | undefined;
    list.onSelect = (item) => {
      selected = item.value;
    };
    list.handleInput('\r');
    assert.equal(selected, 'one');
  });
});

describe('inline menu row gap', () => {
  it('inserts a blank row between items and keeps mouse hits on items', () => {
    const list = new SelectList(
      [
        { value: 'one', label: 'opencode' },
        { value: 'two', label: 'anthropic' },
      ],
      10,
      theme,
      { rowGap: 1 },
    );
    const rows = list.render(40);
    assert.equal(rows.length, 3);
    assert.match(rows[0] ?? '', /opencode/);
    assert.equal(rows[1], '');
    assert.match(rows[2] ?? '', /anthropic/);

    // 鼠标命中按渲染行查表：第 3 行是第二个条目，中间的空行落空。
    // （点选只改高亮，确认只走 Enter——见 handleMouse 的注释。）
    const base = { button: 'left' as const, x: 0, screenX: 0, screenY: 0, width: 40, height: 3, shift: false, alt: false, ctrl: false };
    list.handleMouse({ ...base, type: 'press', y: 2 });
    list.handleMouse({ ...base, type: 'click', y: 2 });
    assert.equal(list.selectedItem()?.value, 'two');

    list.setSelectedIndex(0);
    list.handleMouse({ ...base, type: 'press', y: 1 });
    list.handleMouse({ ...base, type: 'click', y: 1 });
    assert.equal(list.selectedItem()?.value, 'one');
  });

  it('keeps gap rows out of hover highlight', () => {
    // hover 底色做可观测标记：悬停行整行包上 [h]…[/h]。
    const hoverTheme: SelectListTheme = { ...theme, hoverBg: (text) => `[h]${text}[/h]` };
    const list = new SelectList(
      [
        { value: 'one', label: 'opencode' },
        { value: 'two', label: 'anthropic' },
      ],
      10,
      hoverTheme,
      { rowGap: 1 },
    );
    const base = { button: 'none' as const, x: 0, screenX: 0, screenY: 0, width: 40, height: 3, shift: false, alt: false, ctrl: false };
    // 命中查表基于最近一次渲染的行表——生产里每帧先渲染后分发鼠标，这里对齐时序。
    list.render(40);
    // 悬停第二个条目（渲染行 2）：底色落在条目行上。
    list.handleMouse({ ...base, type: 'move', y: 2 });
    assert.match(list.render(40)[2] ?? '', /\[h\]/);
    // 悬停移到间隔行（渲染行 1）：预览底色清空，两行都回到无高亮。
    list.handleMouse({ ...base, type: 'move', y: 1 });
    const rows = list.render(40);
    assert.doesNotMatch(rows[0] ?? '', /\[h\]/);
    assert.doesNotMatch(rows[2] ?? '', /\[h\]/);
  });

  it('defaults to tight rows when rowGap is omitted', () => {
    const list = new SelectList(
      [
        { value: 'one', label: 'opencode' },
        { value: 'two', label: 'anthropic' },
      ],
      10,
      theme,
    );
    const rows = list.render(40);
    assert.equal(rows.length, 2);
    // 无行距时旧行为不变：y 直接是条目行，点选只改高亮。
    const base = { button: 'left' as const, x: 0, screenX: 0, screenY: 0, width: 40, height: 2, shift: false, alt: false, ctrl: false };
    list.handleMouse({ ...base, type: 'press', y: 1 });
    list.handleMouse({ ...base, type: 'click', y: 1 });
    assert.equal(list.selectedItem()?.value, 'two');
  });
});

describe('list activation gesture', () => {
	// 单击移高亮、双击才激活（见 docs/interactions.md）：与工具行、报告分组的开合同一套读法。
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

	const items = [
		{ value: 'one', label: 'opencode' },
		{ value: 'two', label: 'anthropic' },
	];
	const withSpy = (): { list: SelectList; picked: string[] } => {
		const list = new SelectList(items, 10, theme);
		const picked: string[] = [];
		list.onSelect = (item) => picked.push(item.value);
		// 鼠标命中的是渲染行（`lastRowMap`），不先渲染就没有行可点。
		list.render(40);
		return { list, picked };
	};

	it('activates on the second click, not the first', () => {
		const { list, picked } = withSpy();
		for (const event of clickOn(1)) list.handleMouse(event);
		assert.deepEqual(picked, [], '单击只移高亮');
		assert.equal(list.selectedItem()?.value, 'two');
		for (const event of clickOn(1)) list.handleMouse(event);
		assert.deepEqual(picked, ['two'], '双击才激活');
	});

	it('does not count clicks on two different rows as a double click', () => {
		// y 是离散的渲染行号：相邻两行各点一下是「选了一条又选一条」，不是双击。
		const { list, picked } = withSpy();
		for (const event of clickOn(0)) list.handleMouse(event);
		for (const event of clickOn(1)) list.handleMouse(event);
		assert.deepEqual(picked, []);
	});

	it('does not activate twice on a triple click', () => {
		// 三连击 = 单击 + 双击：第 3 下开新序列，否则激活会被连触发两次。
		const { list, picked } = withSpy();
		for (const event of clickOn(1)) list.handleMouse(event);
		for (const event of clickOn(1)) list.handleMouse(event);
		for (const event of clickOn(1)) list.handleMouse(event);
		assert.deepEqual(picked, ['two']);
	});

	it('ignores activation on non-selectable rows', () => {
		const list = new SelectList(
			[{ value: 'h', label: 'Providers', kind: 'header' }, ...items],
			10,
			theme,
		);
		const picked: string[] = [];
		list.onSelect = (item) => picked.push(item.value);
		list.render(40);
		for (const event of clickOn(0)) list.handleMouse(event);
		for (const event of clickOn(0)) list.handleMouse(event);
		assert.deepEqual(picked, [], '组头不可点选');
	});
});
