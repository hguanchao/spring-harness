/**
 * Plugins tab 的数据构造。
 *
 * 这份报告的存在理由是**可诊断**：工具变成插件之后，「工具表里怎么没有 todo」的答案可能是
 * 「插件被 `[plugins] disabled` 关了」、「插件加载失败」，或「插件在但没注册工具」。三种原因
 * 的处置完全不同，所以三者都要能被看见——只列一份成功清单等于让用户去猜。
 *
 * 排版沿用 `/skills` 那套读法：按来源分组、一插件一行、入口路径退成灰注脚——名字与摘要进
 * 视线，路径要核对时才看。
 */

import type { LoadedPlugin } from '@/plugins/host.js';
import type { PluginLoadFailure } from '@/plugins/loader.js';
import type { ReportBlock, ReportItem, ReportTab, RichText, TextSegment } from '@/plugins/sph-tui/report/doc.js';
import { oneLine } from '@/plugins/sph-tui/report/text.js';

export interface PluginsTabInput {
	plugins: readonly LoadedPlugin[];
	failures: readonly PluginLoadFailure[];
	shadowed: readonly string[];
	/** 试图替换固定内置插件、但被拒绝的名字。内置实现仍在。 */
	pinned?: readonly string[];
}

/** 插件来源的展示顺序与标题：同源的插件连着排，来源只写一次。 */
const PLUGIN_ORIGINS: readonly { root: LoadedPlugin['root']; label: string }[] = [
	{ root: 'bundled', label: 'Bundled with sph' },
	{ root: 'user', label: 'User — ~/.sph/plugins' },
	{ root: 'project', label: 'Project — <workspace>/.sph/plugins' },
];

/**
 * 入口路径只留尾部三段。
 *
 * 构建产物目录动辄六七十列，整条绝对路径会把每个插件都撑成两行；来源已经由分组标题交代，
 * 尾部三段足够回答「装的是哪一个」。截过就带 `…/`，别让人以为是完整的相对路径。
 */
function entryLabel(entry: string): string {
	const parts = oneLine(entry).split(/[\\/]/).filter((part) => part !== '');
	if (parts.length <= 3) return entry;
	return `…/${parts.slice(-3).join('/')}`;
}

/** 一个插件提供了什么：只列非空的那几项；全空时明说，不留空白让人以为被截断。 */
function pluginProvides(plugin: LoadedPlugin): RichText {
	const groups: TextSegment[][] = [];
	const names = (prefix: string, list: readonly string[], format: (name: string) => string = (name) => name): TextSegment[] => [
		{ text: `${prefix}: ` },
		...list.flatMap((name, index): TextSegment[] => [
			...(index === 0 ? [] : [{ text: ', ' }]),
			{ text: format(name), tone: 'code' },
		]),
	];
	if (plugin.tools.length > 0) groups.push(names('tools', plugin.tools));
	if (plugin.services.length > 0) groups.push(names('services', plugin.services));
	if (plugin.commands.length > 0) groups.push(names('commands', plugin.commands, (name) => `/${name}`));
	if (groups.length === 0) return 'registers nothing';
	const segments: TextSegment[] = [];
	groups.forEach((group, index) => {
		if (index > 0) segments.push({ text: ' · ' });
		segments.push(...group);
	});
	return segments;
}

export function pluginsTab(input: PluginsTabInput): ReportTab {
	const { plugins, failures, shadowed, pinned = [] } = input;
	const blocks: ReportBlock[] = [];

	if (plugins.length === 0) {
		// 空态要说清「该放哪」与「被禁用是正常原因」——后者正是最常遇到的答案。
		blocks.push({
			kind: 'prose',
			text:
				'No plugins loaded. Bundled plugins live in `src/plugins/` (compiled into `dist/`); ' +
				'third-party ones go in `~/.sph/plugins/` or `<workspace>/.sph/plugins/`.',
		});
		blocks.push({ kind: 'prose', text: 'A plugin disabled in config.toml is deliberately absent:' });
		blocks.push({ kind: 'code', language: 'toml', text: '[plugins]\ndisabled = ["sph-mcp"]' });
	} else {
		// 一句话 caption 交代最常核对的约束（改动要重启才生效）；「插件是什么」的长文
		// 对健康清单是噪音，诊断语境留给空态与失败组。
		blocks.push({ kind: 'caption', text: 'Plugin state is fixed for this process — restart to pick up changes.' });
		for (const { root, label } of PLUGIN_ORIGINS) {
			const group = plugins.filter((plugin) => plugin.root === root);
			if (group.length === 0) continue;
			const items: ReportItem[] = group.map((plugin): ReportItem => {
				// 入口只给第三方插件留注脚：内置插件的入口就是构建产物里那个固定位置，写出来是噪音；
				// 而「同名插件到底装在用户目录还是仓库里」才是真要核对的。加载失败的那些在
				// Failed to load 组里照样带入口，诊断不受影响。
				const notes: RichText[] = [
					...(plugin.root === 'bundled' ? [] : plugin.entries.map((entry): RichText => ({ text: entryLabel(entry) }))),
					...plugin.warnings.map((warning): RichText => ({ text: oneLine(warning), tone: 'warn' })),
				];
				return {
					key: plugin.name,
					label: { text: plugin.name, tone: 'code', bold: true },
					description: pluginProvides(plugin),
					notes: notes.length === 0 ? undefined : notes,
				};
			});
			blocks.push({ kind: 'group', group: { key: root, label, countNoun: 'plugins', items } });
		}
	}

	if (shadowed.length > 0) {
		blocks.push({
			kind: 'prose',
			text:
				'These bundled plugins were replaced by a same-named third-party plugin. Legitimate for ' +
				'patching a built-in, but the bundled service and tools are gone, not merged.',
		});
		blocks.push({
			kind: 'group',
			group: {
				key: 'shadowing',
				label: 'Shadowing',
				collapsible: false,
				items: shadowed.map((name): ReportItem => ({ key: name, label: name })),
			},
		});
	}

	if (pinned.length > 0) {
		blocks.push({ kind: 'prose', text: 'These bundled plugins stay loaded. A same-named third-party plugin was ignored.' });
		blocks.push({
			kind: 'group',
			group: {
				key: 'pinned',
				label: 'Pinned',
				collapsible: false,
				items: pinned.map((name): ReportItem => ({ key: name, label: name })),
			},
		});
	}

	if (failures.length > 0) {
		const items: ReportItem[] = failures.map((failure): ReportItem => ({
			key: failure.name,
			label: failure.name,
			description: oneLine(failure.reason),
			// 失败的名字上 error 红：这一组里它是异常项本体，不该和正常清单一个脸色。
			tone: 'danger',
			notes: failure.entries.map((entry): RichText => ({ text: entry })),
		}));
		blocks.push({ kind: 'group', group: { key: 'failed', label: 'Failed to load', collapsible: false, items } });
	}

	return {
		id: 'plugins',
		label: 'Plugins',
		blocks,
		empty: 'No plugins match that.',
	};
}
