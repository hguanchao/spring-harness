/**
 * Notice 块的排版快测：实线、半行宽、整块居中的提示块（装不下则退回左对齐折行）。
 *
 * 断言前先 `stripAnsi`：颜色是否开启取决于跑测试时的 stdout 是不是 TTY，**别假设它是关的**
 * （这台机器上就是开的）。几何断言用 `visibleWidth`，它本来就忽略转义码。
 * 等级"看起来一样"这条用整行相等来钉——带不带色都成立。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { visibleWidth } from '@/tui/text/utils.js';
import { type NoticeLevel, NoticeComponent } from '@/plugins/sph-tui/messages/notice.js';

const stripAnsi = (text: string): string => text.replace(/\x1B\[[0-9;]*m/g, '');

const render = (text: string, width: number, level: NoticeLevel = 'dim'): string[] =>
	new NoticeComponent(text, level).render(width);

describe('NoticeComponent', () => {
	it('renders one line: a half-row block of solid rules around the text', () => {
		const rows = render('Model set to muse-spark', 60);
		assert.equal(rows.length, 1);
		const line = rows[0] ?? '';
		const plain = stripAnsi(line);
		assert.ok(plain.includes('─'), '应当是实线');
		assert.ok(!plain.includes('┄'), '不再是虚线');
		assert.ok(plain.includes('Model set to muse-spark'));
		// 块宽 33（文字 25 + 两侧各 4 的兜底）> 半行 30，缩进 (60−33)/2 = 13。
		assert.equal(visibleWidth(line), 13 + 33);
		assert.ok(visibleWidth(line) < 60, '整块不该顶满整行');
	});

	it('renders every level identically — the look is uniform, not per-level', () => {
		const lines = (['dim', 'warn', 'error', 'success'] as const).map((level) => render('Model set to X', 80, level)[0] ?? '');
		assert.equal(new Set(lines).size, 1, '等级不该改变表现');
	});

	it('falls back to left-aligned wrapped text when the block would not fit', () => {
		const rows = render('Follow-up queue is full (1) — cancel one first.', 30, 'warn');
		assert.ok(rows.length > 1, '长提示应当折行而不是被截断');
		for (const row of rows) {
			assert.ok(!row.includes('─'), '回退态不画线');
			assert.ok(visibleWidth(row) <= 30);
		}
		assert.ok(stripAnsi(rows.join('\n')).includes('cancel one first.'));
	});
});
