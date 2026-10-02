/**
 * 取色规则的数据层断言。
 *
 * 规则（写在 doc.ts 的类型注释里）：**蓝 = 能照抄进终端/编辑器的字面量；条目主列是名字 →
 * 加粗正文；表格键 → 正文；次级信息 → 灰。**
 *
 * 这些决定全在数据里（`tone` 与字段键），所以能在这里钉住——字符串里塞颜色标记的年代做不到
 * 这一点。用例只读数据、不碰渲染链，毫秒级。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { plainText, type ReportItem, type ReportTab, type RichText, type TextTone } from '@/plugins/sph-tui/report/doc.js';
import { skillsTab } from '@/plugins/sph-tui/report/sources/skills.js';
import { pluginsTab } from '@/plugins/sph-tui/report/sources/plugins.js';
import { mcpTab } from '@/plugins/sph-tui/report/sources/mcps.js';
import { permissionsTab } from '@/plugins/sph-tui/report/sources/permissions.js';
import { commandsTab } from '@/plugins/sph-tui/report/sources/help.js';

/** 一段富文本里点名过的语气（字符串、或没带 tone 的分段 = 没标）。 */
function tonesOf(text: RichText | undefined): TextTone[] {
	if (text === undefined || typeof text === 'string') return [];
	if ('text' in text) return text.tone === undefined ? [] : [text.tone];
	return text.flatMap((segment) => (segment.tone === undefined ? [] : [segment.tone]));
}

const itemsOf = (tab: ReportTab): ReportItem[] =>
	tab.blocks.flatMap((block) => (block.kind === 'group' ? [...block.group.items] : []));

const permissionsInput = {
	approval: 'ask',
	sandboxMode: 'off',
	sandboxAutoAllow: false,
	layers: { user: { sourceDir: '/u/.sph', rules: { allow: ['Bash(git status)'], ask: [], deny: [] } } },
	userConfigPath: '/u/.sph/config.toml',
	projectPath: '/w/.sph/config.toml',
	projectAllowDropped: false,
	approved: [] as string[],
	grantsPath: '/w/.sph/permissions.json',
} as const;

/** 五个 tab 的条目，按来源打标。 */
function items(): { where: string; item: ReportItem }[] {
	const skill = skillsTab({
		catalog: [{ name: 'ast-grep', description: 'Structural search', root: '/roots/a', path: '/roots/a/ast-grep/SKILL.md', userInvocable: true }],
		warnings: [],
		roots: [{ path: '/roots/a', level: 'User' }],
	});
	// 样本得是用户插件：面板只列 user/project 两类来源，内置插件不出现（见 plugins.ts）。
	const plugin = pluginsTab({
		plugins: [{ name: 'sph-mcp', root: 'user', tools: ['mcp'], services: [], commands: [], description: 'MCP', entries: ['/x/index.ts'], warnings: [] }],
		failures: [],
		shadowed: [],
	});
	const mcp = mcpTab({
		servers: [{
			name: 'files', title: 'Filesystem', transport: 'stdio', supported: true, enabled: true, connected: true,
			target: 'npx -y files-mcp',
			origin: { label: '~/.sph/config.toml', path: '/u/.sph/config.toml', editable: true },
			tools: [{ server: 'files', name: 'read_file', description: 'Read a file', schema: {} }],
		}],
		warnings: [],
		sources: [{ label: 'u', path: '/u/.sph/config.toml', status: 'found', count: 1 }],
	});
	const permissions = permissionsTab(permissionsInput);
	const commands = commandsTab({ commands: [{ id: 'help', label: '/help', hint: 'List commands', group: 'Tools' }], aliases: {} });
	return [
		...itemsOf(skill).map((item) => ({ where: 'skills', item })),
		...itemsOf(plugin).map((item) => ({ where: 'plugins', item })),
		...itemsOf(mcp).map((item) => ({ where: 'mcps', item })),
		...itemsOf(permissions).map((item) => ({ where: 'permissions', item })),
		...itemsOf(commands).map((item) => ({ where: 'commands', item })),
	];
}

describe('取色规则：谁该蓝', () => {
	it('条目主列是名字 → 不上任何色（加粗正文就够）', () => {
		const find = (where: string, key: string): ReportItem => {
			const found = items().find((entry) => entry.where === where && entry.item.key === key);
			assert.ok(found, `找不到条目 ${where}/${key}`);
			return found.item;
		};
		for (const [where, key] of [['skills', 'ast-grep'], ['plugins', 'sph-mcp'], ['mcps', 'files'], ['mcps', 'files:read_file']] as const) {
			assert.deepEqual(tonesOf(find(where, key).label), [], `${where}/${key} 是名字，不该上色`);
		}
	});

	it('字面量字段的角色由字段键给（render.ts 的 FIELD_TONES），数据里不再自己标 tone', () => {
		const literalFields = items().flatMap(({ where, item }) =>
			(item.fields ?? [])
				.filter((field) => field.key === 'path' || field.key === 'target')
				.map((field) => ({ where, key: item.key, field })),
		);
		assert.ok(literalFields.length > 0, '样本里应当至少有一个 path/target 字段');
		for (const { where, key, field } of literalFields) {
			assert.deepEqual(
				tonesOf(field.value),
				[],
				`${where}/${key} 的 ${plainText(field.key ?? '')} 取值不该自己标 tone：角色跟着字段键走，两处都写迟早会打架`,
			);
		}
	});

	it('仍然蓝的：命令主列、键位、路径标签、规则动作', () => {
		const labeled = items()
			.filter((entry) => tonesOf(entry.item.label).includes('code'))
			.map((entry) => `${entry.where}:${plainText(entry.item.label)}`);
		// 命令清单的主列是「你敲的东西」——唯一允许主列上码色的地方。
		assert.ok(labeled.some((name) => name.startsWith('commands:')), '命令主列应当保留码色');
		// 路径标签（技能的 Sources 行）也留着：它是要照抄的。
		assert.ok(labeled.some((name) => name === 'skills:User — /roots/a'), `技能的根路径应当保留码色，实际：${labeled.join(', ')}`);
	});
});
