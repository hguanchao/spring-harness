/**
 * 报告数据层的最小快测：doc / filter / fold 三个纯函数模块。
 *
 * 刻意不碰渲染链（TuiAltScreen、假终端、浮层合成）——那些用例曾经整批挂死过。
 * 这里全部是同步纯函数，毫秒级跑完；渲染观感的验收交给手测。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { groupCountSuffix, plainText, reportGroups, type ReportGroup, type ReportTab } from '@/plugins/sph-tui/report/doc.js';
import { filterTab } from '@/plugins/sph-tui/report/filter.js';
import { FoldState } from '@/plugins/sph-tui/report/fold.js';
import { ReportDialog } from '@/plugins/sph-tui/report/dialog.js';

function group(key: string, label: string, items: readonly string[]): ReportGroup {
	return { key, label, items: items.map((name) => ({ key: name, label: name })) };
}

function tab(groups: readonly ReportGroup[]): ReportTab {
	return {
		id: 't',
		label: 'T',
		blocks: [
			{ kind: 'caption', text: 'a caption' },
			...groups.map((g) => ({ kind: 'group' as const, group: g })),
		],
		empty: 'Nothing here.',
	};
}

describe('report action handoff', () => {
	it('keeps the report open when an action handler is installed', () => {
		const reportTab = { ...tab([]), actions: [{ key: 'm', label: 'manage', dropPriority: 0 }] };
		const spec = { id: 't', label: 'T', build: () => reportTab };
		const dialog = new ReportDialog([spec], 't', { workspaceRoot: 'E:/workspace' }, () => 20);
		let closed = false;
		let action: string | undefined;
		dialog.onClose = () => {
			closed = true;
		};
		dialog.onAction = (key) => {
			action = key;
		};
		dialog.handleInput('m');
		assert.equal(action, 'm');
		assert.equal(closed, false);
	});

	it('closes with the action when there is no action handler', () => {
		const reportTab = { ...tab([]), actions: [{ key: 'm', label: 'manage', dropPriority: 0 }] };
		const spec = { id: 't', label: 'T', build: () => reportTab };
		const dialog = new ReportDialog([spec], 't', { workspaceRoot: 'E:/workspace' }, () => 20);
		let action: string | undefined;
		dialog.onClose = (key) => {
			action = key;
		};
		dialog.handleInput('m');
		assert.equal(action, 'm');
	});
});

describe('plainText', () => {
	it('拍平分段结构，不解析任何标记', () => {
		assert.equal(plainText('plain'), 'plain');
		assert.equal(plainText({ text: 'code', tone: 'code' }), 'code');
		assert.equal(
			plainText([
				{ text: 'a', tone: 'code' },
				{ text: 'b' },
			]),
			'ab',
		);
	});
});

describe('groupCountSuffix', () => {
	it('没声明计量词就不渲染后缀', () => {
		assert.equal(groupCountSuffix(group('g', 'L', ['x']), 1, 1), null);
	});
	it('全部命中报 (n 词)，单数去 s；部分命中报 (命中/总数)', () => {
		const withNoun = { ...group('g', 'L', ['x', 'y']), countNoun: 'skills' };
		assert.equal(groupCountSuffix(withNoun, 2, 2), '(2 skills)');
		assert.equal(groupCountSuffix(withNoun, 1, 1), '(1 skill)');
		assert.equal(groupCountSuffix(withNoun, 1, 2), '(1/2 skills)');
	});
});

describe('reportGroups', () => {
	it('按出现顺序只收 group 块', () => {
		const groups = reportGroups(tab([group('a', 'A', []), group('b', 'B', [])]).blocks);
		assert.deepEqual(
			groups.map((g) => g.key),
			['a', 'b'],
		);
	});
});

describe('filterTab', () => {
	const t = tab([group('a', 'Alpha', ['apple', 'apricot']), group('b', 'Beta', ['banana'])]);

	it('空查询原样返回：不重排、不丢组', () => {
		const filtered = filterTab(t, '');
		assert.equal(filtered.filtering, false);
		assert.equal(filtered.blocks.length, t.blocks.length);
		assert.equal(filtered.hits, 3);
		const countA = filtered.counts.get('a');
		assert.deepEqual(countA, { hit: 2, total: 2 });
	});

	it('有查询时丢零命中组，命中数报真实比例', () => {
		const filtered = filterTab(t, 'apple');
		assert.equal(filtered.filtering, true);
		assert.equal(filtered.hits, 1);
		// Beta 组零命中：整组退场
		assert.deepEqual(
			reportGroups(filtered.blocks).map((g) => g.key),
			['a'],
		);
		assert.deepEqual(filtered.counts.get('b'), { hit: 0, total: 1 });
	});

	it('组标题也进检索范围', () => {
		const filtered = filterTab(t, 'beta');
		assert.equal(filtered.hits, 1);
		assert.deepEqual(
			reportGroups(filtered.blocks).map((g) => g.key),
			['b'],
		);
	});
});

describe('FoldState', () => {
	const collapsible = group('g', 'G', ['x']);

	it('缺省收起；翻转会记住；只记被显式改过的组', () => {
		const fold = new FoldState();
		assert.equal(fold.isExpanded('t', collapsible), false);
		assert.equal(fold.toggle('t', collapsible), true);
		assert.equal(fold.isExpanded('t', collapsible), true);
		// 没动过的组仍按默认值走
		assert.equal(fold.isExpanded('t', group('h', 'H', ['y'])), false);
	});

	it('initiallyExpanded: true 的组缺省就是展开的', () => {
		const fold = new FoldState();
		const open = { ...group('o', 'O', ['x']), initiallyExpanded: true };
		assert.equal(fold.isExpanded('t', open), true);
	});

	it('按 tab 分开存', () => {
		const fold = new FoldState();
		fold.set('t1', 'g', true);
		assert.equal(fold.isExpanded('t1', collapsible), true);
		assert.equal(fold.isExpanded('t2', collapsible), false);
	});

	it('forceExpand 只看不改；不可折叠组永远展开', () => {
		const fold = new FoldState();
		fold.set('t', 'g', false);
		assert.equal(fold.isExpanded('t', collapsible, true), true);
		assert.equal(fold.isExpanded('t', collapsible), false);
		const fixed = { ...group('f', 'F', ['z']), collapsible: false };
		fold.set('t', 'f', false);
		assert.equal(fold.isExpanded('t', fixed), true);
	});
});
