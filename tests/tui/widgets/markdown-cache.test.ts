/**
 * Markdown 的缓存契约：**文本没变就不能作废缓存**。
 *
 * 这是性能前提，不是小优化——解析+排版随长度线性涨（实测 8K 字 6.6ms、32K 字 64ms、
 * 82K 字 178ms），而缓存命中是 0ms。宿主常拿「同值」刷新（活得久的分组每帧重建、
 * 流式累积值重放），一旦每次都重解析，一条长思考展开着就能把帧率压到个位数。
 *
 * 断言用**数组同一性**：缓存命中时 `render` 直接返回上次那个数组；重解析必然是新数组。
 * 内容相等说明不了问题——重新解析出来的内容当然也相等。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Markdown } from '@/tui/index.js';
import { getMarkdownTheme } from '@/plugins/sph-tui/theme/theme.js';

const make = (text: string): Markdown =>
	new Markdown(text, 0, 0, getMarkdownTheme(), { color: (content: string) => content });

describe('markdown text cache', () => {
	it('keeps the cached lines when the text is set to the same value', () => {
		const md = make('hello **world**');
		const first = md.render(40);
		md.setText('hello **world**');
		assert.equal(md.render(40), first, '同值 setText 必须留住缓存');
	});

	it('re-renders when the text actually changes', () => {
		const md = make('hello');
		const first = md.render(40);
		md.setText('hello world');
		assert.notEqual(md.render(40), first);
	});

	it('still drops the cache on invalidate()', () => {
		// 换主题色一类「内容没变但要重解析」的场合走 invalidate，不被同值短路挡住。
		const md = make('hello');
		const first = md.render(40);
		md.invalidate();
		assert.notEqual(md.render(40), first);
	});
});
