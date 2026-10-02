/**
 * `/plugins` 面板的数据层快测：内置插件从清单里隐去，但它的三类诊断出口都还在。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LoadedPlugin } from '@/plugins/host.js';
import { pluginsTab, type PluginsTabInput } from '@/plugins/sph-tui/report/sources/plugins.js';

function plugin(name: string, root: LoadedPlugin['root']): LoadedPlugin {
	return {
		name,
		entries: [`/abs/${name}/index.js`],
		root,
		tools: [],
		services: [],
		commands: [],
		warnings: [],
	};
}

function text(input: PluginsTabInput): string {
	return JSON.stringify(pluginsTab(input).blocks);
}

describe('plugins tab', () => {
	it('lists user and project plugins, never the bundled ones', () => {
		const body = text({
			plugins: [plugin('sph-tools', 'bundled'), plugin('sph-tui', 'bundled'), plugin('mine', 'user'), plugin('theirs', 'project')],
			failures: [],
			shadowed: [],
		});
		assert.match(body, /mine/);
		assert.match(body, /theirs/);
		assert.doesNotMatch(body, /sph-tools/);
		assert.doesNotMatch(body, /Bundled with sph/);
	});

	it('says nothing is installed when only bundled plugins are loaded', () => {
		const tab = pluginsTab({
			plugins: [plugin('sph-tools', 'bundled')],
			failures: [],
			shadowed: [],
		});
		assert.deepEqual(tab.blocks, [{ kind: 'empty', text: 'No user or project plugins.' }]);
	});

	it('still reports a bundled plugin that failed to load', () => {
		// 内置插件不列 ≠ 它的故障也不报：加载失败是「工具表里为什么没有它」的答案本体。
		const body = text({
			plugins: [],
			failures: [{ name: 'sph-llm', entries: ['/abs/sph-llm/index.js'], reason: 'boom' }],
			shadowed: [],
		});
		assert.match(body, /Failed to load/);
		assert.match(body, /sph-llm/);
		assert.match(body, /boom/);
	});

	it('keeps the shadowing and pinned notes about bundled plugins', () => {
		// 被第三方顶掉 / 顶不动，都是「你装的那个和内置撞名了」，两条都得说。
		const body = text({ plugins: [], failures: [], shadowed: ['sph-tools'], pinned: ['sph-tui'] });
		assert.match(body, /Shadowing/);
		assert.match(body, /Pinned/);
		assert.match(body, /sph-tools/);
		assert.match(body, /sph-tui/);
	});
});
