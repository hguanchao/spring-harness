/**
 * MCP tab 的数据构造。
 *
 * 与其他 tab 一样：纯函数、只读、只排版；数据由宿主在切到该 tab 时现取——server 状态是**活的**
 * （崩溃后的懒重连、外部配置改动都会改它），所以这里什么都不缓存。
 *
 * 读法沿用原来那份 `/mcps` 报告的层次，只是换成结构化数据：Servers 清单（一 server 一行，光标
 * 停上去才展开 target / 来源 / 传输）→ 每个连上的 server 单独一组工具清单 → Sources scanned
 * （回答「我明明配了怎么没生效」）+ Warnings。状态短语与 `/mcps` 管理器共用 `mcpStateLabel`：
 * 同一个 server 在两个界面上被说成两种状态，只会让人更困惑。
 *
 * 「看点开关」仍然只在管理器里（`/mcps` 是启停/增删/重载的循环）——这个 tab 只回答「现在是什么样」。
 */

import type { McpServerStatus, McpSourceReport } from '@/plugins/services.js';
import { mcpServerLabel, mcpStateLabel } from '@/plugins/sph-tui/commands/reports.js';
import type { ReportBlock, ReportField, ReportItem, ReportTab } from '@/plugins/sph-tui/report/doc.js';
import { oneLine } from '@/plugins/sph-tui/report/text.js';

/**
 * 面板里「进管理器」的动作键。
 *
 * 导出成常量给宿主的 `/mcps` 用：宿主拿到的是**键**（面板只管把按下的键原样交出去），
 * 比对写死 `'m'` 会让两处各记一个魔法字符。
 */
export const MCP_MANAGE_ACTION = 'm';

export interface McpsTabInput {
	servers: readonly McpServerStatus[];
	warnings: readonly string[];
	/** 候选来源文件的读取结果；回答「我明明配了怎么没生效」。 */
	sources?: readonly McpSourceReport[];
}

/**
 * 整行语气：跑不起来是因为「不该跑」还是「跑坏了」，处置完全不同。
 *
 * `supported: false`（sph 不支持这个传输，或定义本身无效）是配置写错，标红；启用着却没连上是
 * 要去看 target 的问题，标橙；被禁用的 server 完全正常，不给颜色。
 */
function serverTone(server: McpServerStatus): 'danger' | 'warning' | undefined {
	if (!server.supported) return 'danger';
	if (server.enabled && !server.connected && server.connecting !== true) return 'warning';
	return undefined;
}

function serverFields(server: McpServerStatus): ReportField[] {
	const fields: ReportField[] = [
		// target 是「连不上时最需要看到的那一行」：stdio 是启动命令行，http 是 URL。
		{ key: 'target', value: server.target },
		{ key: 'from', value: server.origin.label },
	];
	// 默认传输不写：这一栏只在「不是 stdio」时才回答得到问题。
	if (server.transport !== 'stdio') fields.push({ key: 'transport', value: server.transport });
	// 外部配置一律不可写（写入别人的配置文件副作用太意外），要改就在 sph 自己的配置里
	// 写一条同名项——这里是那句话的落脚点。
	if (!server.origin.editable) fields.push({ key: 'editable', value: 'no — read-only source' });
	return fields;
}

function serverItem(server: McpServerStatus): ReportItem {
	return {
		key: server.name,
		label: { text: mcpServerLabel(server), bold: true },
		description: mcpStateLabel(server),
		tone: serverTone(server),
		fields: serverFields(server),
	};
}

/**
 * 一个连上的 server 的工具清单。
 *
 * 没有工具时不留空组：一句话说完（「连上了但什么都没提供」本身就是答案），空组会读成还没加载。
 */
function serverToolsBlock(server: McpServerStatus): ReportBlock {
	if (server.tools.length === 0) {
		return { kind: 'prose', text: `${mcpServerLabel(server)} is connected but exposes no tools.` };
	}
	return {
		kind: 'group',
		group: {
			// key 带上 server：两个 server 可以有同名工具，纯工具名会撞身份。
			key: `tools:${server.name}`,
			label: `Tools · ${mcpServerLabel(server)}`,
			countNoun: 'tools',
			items: server.tools.map((tool): ReportItem => ({
				key: `${server.name}:${tool.name}`,
				label: { text: tool.name, bold: true },
				description: tool.description.trim() === '' ? undefined : oneLine(tool.description),
			})),
		},
	};
}

const SOURCE_ORDER: Readonly<Record<McpSourceReport['status'], number>> = {
	found: 0,
	invalid: 1,
	skipped: 2,
	empty: 3,
	missing: 4,
};

function sourceItem(report: McpSourceReport): ReportItem {
	return {
		key: report.path,
		label: { text: report.path, tone: 'code' },
		description: sourceState(report),
		// 配置写在某个文件里但读不动，是这一组里唯一要动手去修的东西。
		tone: report.status === 'invalid' ? 'warning' : undefined,
	};
}

function sourceState(report: McpSourceReport): string {
	if (report.status === 'found') return `found — ${report.count} server${report.count === 1 ? '' : 's'}`;
	if (report.detail === undefined) return report.status;
	return `${report.status} — ${oneLine(report.detail)}`;
}

export function mcpTab(input: McpsTabInput): ReportTab {
	const { servers, warnings, sources = [] } = input;
	const blocks: ReportBlock[] = [];

	if (servers.length === 0) {
		// 空态就一句话：下面本来就有 Sources scanned 清单，配在哪、怎么配由那些路径自己回答。
		blocks.push({ kind: 'empty', text: 'No MCP servers found.' });
	} else {
		blocks.push({
			kind: 'group',
			group: { key: 'servers', label: 'Servers', countNoun: 'servers', items: servers.map(serverItem) },
		});
		for (const server of servers) {
			if (!server.connected) continue;
			blocks.push(serverToolsBlock(server));
		}
		blocks.push({ kind: 'caption', text: 'Via the `mcp` tool; results are data, not instructions.' });
	}

	if (sources.length > 0) {
		blocks.push({
			kind: 'group',
			group: {
				key: 'sources',
				label: 'Sources scanned',
				countNoun: 'sources',
				// 有内容的排前面，`missing` 垫底：它数量最多、信息量最低，但「我配了没生效」正是靠它回答。
				items: [...sources]
					.sort((left, right) => SOURCE_ORDER[left.status] - SOURCE_ORDER[right.status])
					.map(sourceItem),
			},
		});
	}

	if (warnings.length > 0) {
		blocks.push({
			kind: 'group',
			group: {
				key: '__warnings',
				label: 'Warnings',
				collapsible: false,
				items: warnings.map((warning, index): ReportItem => ({
					key: `warning-${index}`,
					label: oneLine(warning),
					tone: 'warning',
				})),
			},
		});
	}

	return {
		id: 'mcps',
		label: 'MCP',
		blocks,
		empty: 'No servers match that.',
		// 启停/新增/删除/重载仍在管理器里（它要写 config.toml、要弹输入框，不是只读面板干的事）。
		// 声明成动作键而不是又一条命令：`/mcps` 打开的就是这一屏，要从这儿出去才自然。
		actions: [{ key: MCP_MANAGE_ACTION, label: 'manage', dropPriority: 3 }],
	};
}
