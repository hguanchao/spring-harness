/**
 * 报告 tab 注册表：tabId → 怎么建这块报告。
 *
 * 「一个弹窗」的关键在这里：5 个 tab 是数据（各一个 build 函数），不是 5 份渲染代码。
 * 新增一类报告 = 这里加一项，弹窗代码一行不动。
 *
 * build 是**懒**的，openReport 只调落点那个，`Tab` 切到谁才建谁：各数据源的成本差得远
 * （扫技能目录要读文件头、插件报告走插件宿主），打开时全建等于每次 `/skills` 都顺带做完
 * 所有 IO。缓存只在本次打开内有效，关闭即丢——数据必须反映打开这一刻的真实状态。
 */

import { scanSkills, skillRootGroups } from '@/plugins/sph-skills/scan.js';
import type { SkillRoot } from '@/plugins/sph-skills/scan.js';
import type { ReportTab } from './doc.js';
import { skillsTab } from './sources/skills.js';

/** 建一块报告所需的环境。数据源只拿自己要的，不接触 TUI。 */
export interface ReportContext {
	/** 工作区根：技能扫描按它定根清单。 */
	workspaceRoot: string;
}

export interface ReportTabSpec {
	id: string;
	label: string;
	build(context: ReportContext): ReportTab;
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

/** 一期只接 /skills 灰度跑通；plugins / permissions / commands / keys 依次跟进（S3）。 */
export const REPORT_TABS: readonly ReportTabSpec[] = [
	{
		id: 'skills',
		label: 'Skills',
		build: (context) => {
			const { catalog, warnings, roots } = ensureScan(context.workspaceRoot);
			return skillsTab({ catalog, warnings, roots });
		},
	},
];

/** 按落点 id 取 tab 定义；id 未注册说明调用方传错了，宁可显式炸出来。 */
export function findReportTab(id: string): ReportTabSpec {
	const spec = REPORT_TABS.find((tab) => tab.id === id);
	if (spec === undefined) throw new Error(`Unknown report tab: ${id}`);
	return spec;
}
