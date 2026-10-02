/**
 * 代码块的取色边界：**一律灰**，包括 `diff` 围栏。
 *
 * 这是拍板过的设计：转写区的代码块（含模型贴的 diff）不上色——代码块要么当证据读，要么当
 * 原文抄；按语言猜颜色是另一种"替模型排版"。要着色的 diff 在**工具输出**那一侧
 * （见 tool-diff.ts 的 looksLikeUnifiedDiff / diffLineRole）。这里把它钉住，免得谁又来加特判。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Markdown } from '@/tui/index.js';
import { getMarkdownTheme, theme, type ThemeColor } from '@/plugins/sph-tui/theme/theme.js';

/** 某个角色实际产出的前景序列（真彩 / 256 / 16 色档各自不同，向主题问）。 */
const seq = (role: ThemeColor): string => theme.fg(role, '\u0000').split('\u0000')[0] ?? '';

const render = (markdown: string): string =>
	new Markdown(markdown, 0, 0, getMarkdownTheme(), { color: (content) => theme.fg('mdText', content) })
		.render(64)
		.join('\n');

describe('代码块一律不上色', () => {
	it('diff 围栏也是灰的：不按语言特判', () => {
		const out = render(['```diff', '@@ -1 +1 @@', '-a', '+b', '```'].join('\n'));
		assert.ok(!out.includes(seq('success')), '不该出现新增绿');
		assert.ok(!out.includes(seq('error')), '不该出现删除红');
		assert.ok(!out.includes(seq('primary')), '不该出现 hunk 紫');
	});

	it('`-` 开头的行留在代码块里，不被 markdown 当成列表项', () => {
		const out = render(['```ts', '-const a = 1;', '```'].join('\n'));
		assert.ok(out.includes('-const a = 1;'), '应当原样保留在代码块里');
	});
});
