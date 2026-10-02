/**
 * 报告 tab 注册表：tabId → 怎么建这块报告。
 *
 * 「一个弹窗」的关键在这里：5 个 tab 是数据（各一个 build 函数），不是 5 份渲染代码。
 * 新增一类报告 = 这里加一项，弹窗代码一行不动。
 *
 * build 是**懒**的，openReport 只调落点那个，`Tab` 切到谁才建谁：各数据源的成本差得远
 * （扫技能目录要读文件头、插件报告走插件宿主、权限要读规则与授权文件），打开时全建等于
 * 每次 `/skills` 都顺带做完所有 IO。缓存只在本次打开内有效，关闭即丢——数据必须反映
 * 打开这一刻的真实状态。
 */

import { scanSkills, skillRootGroups } from '@/plugins/sph-skills/scan.js';
import type { SkillRoot } from '@/plugins/sph-skills/scan.js';
import type { LoadedPlugin } from '@/plugins/host.js';
import type { PluginLoadFailure } from '@/plugins/loader.js';
import type { ReportTab } from './doc.js';
import { skillsTab } from './sources/skills.js';
import { pluginsTab } from './sources/plugins.js';
import { permissionsTab, type PermissionsTabInput } from './sources/permissions.js';
import { mcpTab, type McpsTabInput } from './sources/mcps.js';
import { commandsTab, keysTab, type HelpTabsInput } from './sources/help.js';

/** 建一块报告所需的环境。数据源只拿自己要的，不接触 TUI。 */
export interface ReportContext {
	/** 工作区根：技能扫描按它定根清单。 */
	workspaceRoot: string;
	/**
	 * `/plugins` 落点：插件宿主的当下摘要。getter 而不是值——切到该 tab 才取，
	 * 而且每次打开报告都要取「现在」的，不吃快照。
	 */
	plugins?: () => {
		plugins: readonly LoadedPlugin[];
		failures: readonly PluginLoadFailure[];
		shadowed: readonly string[];
		pinned?: readonly string[];
	};
	/** `/permissions` 落点：权限运行时的当下状态。切到该 tab 才取。 */
	permissions?: () => PermissionsTabInput;
	/** `/mcps` 落点：MCP 服务的当下状态（server 懒重连会改它）。切到该 tab 才取。 */
	mcp?: () => McpsTabInput;
	/** `/help` 落点：命令清单、别名与键位注册表。切到该 tab 才取。 */
	help?: () => HelpTabsInput;
}

export interface ReportTabSpec {
	id: string;
	label: string;
	build(context: ReportContext): ReportTab;
}

/** getter 缺席是装配错误（宿主忘了给某个 tab 接数据源），宁可在这里炸清楚。 */
function required<T>(value: T | undefined, tab: string): T {
	if (value === undefined) throw new Error(`Report tab "${tab}" has no data source on ReportContext`);
	return value;
}

/** 一次技能扫描的缓存：目录与根清单要来自同一遍扫描，各取各的就会扫两遍。 */
let lastScan: { root: string; catalog: ReturnType<typeof scanSkills>['catalog']; warnings: string[]; roots: SkillRoot[] } | undefined;

function ensureScan(root: string): { catalog: ReturnType<typeof scanSkills>['catalog']; warnings: string[]; roots: SkillRoot[] } {
	if (lastScan === undefined || lastScan.root !== root) {
		const { catalog, warnings } = scanSkills(root);
		lastScan = { root, catalog, warnings, roots: skillRootGroups(root) };
	}
	return lastScan;
}

/** 顺序即 tab 栏顺序：Skills / Plugins / MCP 是清单，Permissions 是安全面，Commands / Keys 是用法。 */
export const REPORT_TABS: readonly ReportTabSpec[] = [
	{
		id: 'skills',
		label: 'Skills',
		build: (context) => {
			const { catalog, warnings, roots } = ensureScan(context.workspaceRoot);
			return skillsTab({ catalog, warnings, roots });
		},
	},
	{
		id: 'plugins',
		label: 'Plugins',
		build: (context) => pluginsTab(required(context.plugins?.(), 'plugins')),
	},
	{
		id: 'mcps',
		label: 'MCP',
		build: (context) => mcpTab(required(context.mcp?.(), 'mcps')),
	},
	{
		id: 'permissions',
		label: 'Permissions',
		build: (context) => permissionsTab(required(context.permissions?.(), 'permissions')),
	},
	{
		id: 'commands',
		label: 'Commands',
		build: (context) => commandsTab(required(context.help?.(), 'commands')),
	},
	{
		id: 'keys',
		label: 'Keys',
		build: (context) => keysTab(required(context.help?.(), 'keys')),
	},
];

/** 按落点 id 取 tab 定义；id 未注册说明调用方传错了，宁可显式炸出来。 */
export function findReportTab(id: string): ReportTabSpec {
	const spec = REPORT_TABS.find((tab) => tab.id === id);
	if (spec === undefined) throw new Error(`Unknown report tab: ${id}`);
	return spec;
}
