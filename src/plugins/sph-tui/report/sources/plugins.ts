/**
 * Plugins tab 的数据构造。
 *
 * 这份报告的存在理由是**可诊断**：工具变成插件之后，「工具表里怎么没有 todo」的答案可能是
 * 「插件被 `[plugins] disabled` 关了」、「插件加载失败」，或「插件在但没注册工具」。三种原因
 * 的处置完全不同，所以三者都要能被看见——只列一份成功清单等于让用户去猜。
 *
 * 读法照着 Grok 的插件面板：按来源分组、一插件一行（只有名字），光标停到哪一条才展开那条的
 * 明细——自述、能力清单、入口路径。一屏只有一条明细，所以入口路径这种「核对时才看」的长文本
 * 也放得下，不必再截成三段。
 *
 * 清单只列用户与项目这两类来源：内置插件不出现（理由见 PLUGIN_ORIGINS）。所以这份清单回答的是
 * 「我自己装了什么、它坏在哪」，而不是「sph 带了哪些插件」——后者属于文档。
 */

import type { LoadedPlugin } from '@/plugins/host.js';
import type { PluginLoadFailure } from '@/plugins/loader.js';
import type { ReportBlock, ReportField, ReportItem, ReportTab, RichText, TextSegment } from '@/plugins/sph-tui/report/doc.js';
import { oneLine } from '@/plugins/sph-tui/report/text.js';

export interface PluginsTabInput {
	plugins: readonly LoadedPlugin[];
	failures: readonly PluginLoadFailure[];
	shadowed: readonly string[];
	/** 试图替换固定内置插件、但被拒绝的名字。内置实现仍在。 */
	pinned?: readonly string[];
}

/**
 * 插件来源的展示顺序与标题：同源的插件连着排，来源只写一次。
 *
 * **不含 `bundled`**：内置插件随 sph 一起发布、永远都在，列出来只是把用户自己装的那一两个
 * 淹在十几行里，看一眼不知道哪个是自己加的。它们的诊断去处都还在——加载失败照旧进
 * Failed to load，被第三方顶掉或占位照旧进 Shadowing / Pinned，那三处才是「内置」真正
 * 值得出现的地方。
 */
const PLUGIN_ORIGINS: readonly { root: LoadedPlugin['root']; label: string }[] = [
	{ root: 'user', label: 'User — ~/.sph/plugins' },
	{ root: 'project', label: 'Project — <workspace>/.sph/plugins' },
];

/**
 * 能力种类的固定顺序。
 *
 * 顺序固定是这份清单能被纵向扫读的前提（Claude Code 的组件清单、Codex 的列都是这个读法）：
 * 每个插件都按 tools → services → commands 排，眼睛才知道该往哪一行找。整块明细的行序
 * （自述 → 能力 → 入口）见 {@link pluginFields}。
 */
const PROVIDES_KINDS: readonly {
	label: string;
	of: (plugin: LoadedPlugin) => readonly string[];
	format?: (name: string) => string;
}[] = [
	{ label: 'tools', of: (plugin) => plugin.tools },
	{ label: 'services', of: (plugin) => plugin.services },
	{ label: 'commands', of: (plugin) => plugin.commands, format: (name) => `/${name}` },
];

/**
 * 一个插件提供了什么：**一种能力一项明细**，怎么排交给渲染层。
 *
 * 早先是「一行里用 `·` 串起来的散文」，折行断点随机，出现两种断头：`services:` 留在行尾、值甩到
 * 下一行；`·` 停在行尾。改成明细项之后，键与取值各归各位——键由渲染层补到对齐列，取值自己折行，
 * 两者不可能被拆开。
 *
 * 全空时返回 undefined，由调用方明说「什么都没提供」，不留空白让人以为被截断。
 */
function pluginProvides(plugin: LoadedPlugin): readonly ReportField[] | undefined {
	const kinds = PROVIDES_KINDS.filter((kind) => kind.of(plugin).length > 0);
	if (kinds.length === 0) return undefined;
	return kinds.map((kind): ReportField => ({
		key: kind.label,
		value: kind.of(plugin).flatMap((name, index): TextSegment[] => [
			...(index === 0 ? [] : [{ text: ', ' }]),
			{ text: kind.format?.(name) ?? name },
		]),
	}));
}

/**
 * 一条条目的明细：自述 / 能力清单 / 入口路径。
 *
 * 入口路径给**完整**的绝对路径，不做缩写——它是「同名插件到底装在用户目录还是仓库里」的
 * 唯一答案，缩成 `…/plugins/x/index.ts` 之后那个问题的答案就没了，而明细本来就按宽度折行。
 * 内置插件的入口是构建产物里的固定位置，比第三方那句更没悬念，但两类都显示才不会让人以为
 * 「内置插件没有路径」——同一个字段，规则就该是同一条。
 */
function pluginFields(plugin: LoadedPlugin): ReportField[] {
	return [
		...(plugin.description === undefined ? [] : [{ key: 'description', value: plugin.description }]),
		...(pluginProvides(plugin) ?? [{ key: 'registers', value: 'nothing' }]),
		...plugin.entries.map((entry): ReportField => ({ key: 'path', value: { text: entry } })),
	];
}

export function pluginsTab(input: PluginsTabInput): ReportTab {
	const { failures, shadowed, pinned = [] } = input;
	// 只列用户自己装的：内置插件不出现（理由见 PLUGIN_ORIGINS）。
	const plugins = input.plugins.filter((plugin) => plugin.root !== 'bundled');
	const blocks: ReportBlock[] = [];

	if (plugins.length === 0) {
		// 空态一句话，与 Skills / MCP 同一个读法：放哪、怎么禁用属于文档，不在面板里铺开。
		// 措辞点明「用户/项目」两类：内置插件不在这里出现，「没有」说的是你自己没装。
		blocks.push({ kind: 'empty', text: 'No user or project plugins.' });
	} else {
		for (const { root, label } of PLUGIN_ORIGINS) {
			const group = plugins.filter((plugin) => plugin.root === root);
			if (group.length === 0) continue;
			const items: ReportItem[] = group.map((plugin): ReportItem => {
				// 警告留作注脚（不随光标走）：它是这条插件出了问题，不该要人把光标移上去才发现。
				const notes: RichText[] = plugin.warnings.map((warning): RichText => ({ text: oneLine(warning), tone: 'warn' }));
				return {
					key: plugin.name,
					label: { text: plugin.name, bold: true },
					fields: pluginFields(plugin),
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
