/**
 * 工具输出里的统一 diff：判定与取色角色。
 *
 * 判定只认**结构标记**（`diff --git ` 文件头 / `@@ -a,b +c,d @@` hunk 头）——只有行首 `-` / `+`
 * 的文本不算 diff，否则聊天里的列表、分隔线会被误上色（不猜内容是这套界面的基本原则）。
 * 角色只给名字（success / error / primary / muted），具体颜色由主题决定——tool-diff 不 import 主题。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	diffLineNumbers,
	fileChangeFromArgs,
	looksLikeUnifiedDiff,
	matchLineFromResult,
	singleLineNumber,
	unifiedDiffLineKind,
} from '@/plugins/sph-tui/tools/tool-diff.js';

describe('looksLikeUnifiedDiff', () => {
	it('认带 hunk 头的 git diff，也认只有文件头的形态', () => {
		assert.equal(looksLikeUnifiedDiff(['diff --git a/x.ts b/x.ts', '@@ -1,3 +1,4 @@', '-a', '+b'].join('\n')), true);
		assert.equal(looksLikeUnifiedDiff(['diff --git a/x.ts b/x.ts', 'index 1a2b..3c4d 100644'].join('\n')), true);
		assert.equal(looksLikeUnifiedDiff('@@ -1 +1 @@\n-a\n+b'), true);
	});

	it('行首 `-` / `+` 的普通文本不算 diff', () => {
		assert.equal(looksLikeUnifiedDiff(['- 第一项', '- 第二项', '+ 加号开头的散文'].join('\n')), false);
		assert.equal(looksLikeUnifiedDiff('ok 14 tests\n--- done ---\ndone'), false);
	});
});

describe('diffLineNumbers', () => {
	it('hunk 头给两侧起点：`-` 只走旧、`+` 只走新、上下文两边都走', () => {
		const lines = [
			'diff --git a/x.ts b/x.ts',
			'index 1a2b..3c4d 100644',
			'--- a/x.ts',
			'+++ b/x.ts',
			'@@ -9,6 +9,7 @@ export function main() {',
			' const keep = 1;',
			'-const b = 2;',
			'+const b = 3;',
			'+const c = 4;',
			' const tail = 5;',
		];
		const numbers = diffLineNumbers(lines);
		assert.deepEqual(numbers.slice(0, 4), [{}, {}, {}, {}], '文件头不属于任何一侧，栏留空');
		assert.deepEqual(numbers[4], {}, 'hunk 头自己不占行号');
		assert.deepEqual(numbers[5], { old: 9, new: 9 }, '上下文两边同步走');
		assert.deepEqual(numbers[6], { old: 10 }, '删除只走旧');
		assert.deepEqual(numbers[7], { new: 10 }, '新增只走新');
		assert.deepEqual(numbers[8], { new: 11 });
		assert.deepEqual(numbers[9], { old: 11, new: 12 }, '删过一行之后，两侧就对不齐了——这正是要显示两列的理由');
	});

	it('多个 hunk 各按自己的头重新起算', () => {
		const numbers = diffLineNumbers(['@@ -1 +1 @@', '-a', '+b', 'diff --git a/y b/y', '@@ -40,2 +40,3 @@', ' ctx', '+new', '+new2']);
		assert.deepEqual(numbers[1], { old: 1 });
		assert.deepEqual(numbers[2], { new: 1 });
		assert.deepEqual(numbers[5], { old: 40, new: 40 }, '上下文先占掉 40');
		assert.deepEqual(numbers[6], { new: 41 }, '新增拿到的是它的下一行');
		assert.deepEqual(numbers[7], { new: 42 });
	});
});

describe('singleLineNumber', () => {
	it('单列显示相关的那一侧：删显旧号、加与上下文显新号', () => {
		assert.equal(singleLineNumber({ old: 12 }), 12, '删除行只有旧号');
		assert.equal(singleLineNumber({ new: 12 }), 12, '新增行只有新号');
		assert.equal(singleLineNumber({ old: 11, new: 12 }), 12, '上下文取新号');
	});
});

describe('matchLineFromResult / lineBase', () => {
	it('从 edit 的结果里取命中行；取不到就没有行号', () => {
		assert.equal(matchLineFromResult('updated src/app.ts (1 replacement at line 12)'), 12);
		assert.equal(matchLineFromResult('updated src/app.ts (3 replacements)'), undefined);
	});

	it('edit 的片段从命中行起算；replace_all 与缺行号时都不给起点', () => {
		const args = { old_string: 'a\nb', new_string: 'a\nc' };
		assert.equal(fileChangeFromArgs('edit', args, 12)?.lineBase, 12);
		assert.equal(fileChangeFromArgs('edit', args)?.lineBase, undefined, '工具没报命中行就不画行号');
		assert.equal(fileChangeFromArgs('edit', { ...args, replace_all: true }, 12)?.lineBase, undefined, '命中多处时片段行号对不上文件');
	});

	it('write 写整份内容：行号从 1 起', () => {
		assert.equal(fileChangeFromArgs('write', { content: 'a\nb\nc' })?.lineBase, 1);
	});
});

describe('unifiedDiffLineKind', () => {
	it('文件头是 meta（`+++` 不能读成新增），hunk 头、增删、上下文各归各的', () => {
		assert.equal(unifiedDiffLineKind('diff --git a/x.ts b/x.ts'), 'meta');
		assert.equal(unifiedDiffLineKind('--- a/x.ts'), 'meta');
		assert.equal(unifiedDiffLineKind('+++ b/x.ts'), 'meta');
		assert.equal(unifiedDiffLineKind('index 1a2b..3c4d 100644'), 'meta');
		assert.equal(unifiedDiffLineKind('@@ -1,3 +1,4 @@'), 'hunk');
		assert.equal(unifiedDiffLineKind('+added'), 'add');
		assert.equal(unifiedDiffLineKind('-removed'), 'del');
		assert.equal(unifiedDiffLineKind(' context'), 'ctx');
	});
});
