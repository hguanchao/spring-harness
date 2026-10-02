/**
 * Skills tab 的数据构造。
 *
 * 只做「数据 → 报告结构」，不碰 TUI：拉取数据留在命令里，排版留在渲染层。这样这份映射不用起
 * 整个界面就能测，而它恰恰最容易退化成空壳——列表为空、某个根没货、同名技能被两个根广告，
 * 都是真实会遇到、手测很容易漏的分支。
 *
 * 分组与排序沿用扫描顺序，因为它是**覆盖语义**的直接映射：`scanSkills` 按根的顺序扫描，后者覆盖
 * 前者，所以「同名谁赢」这个问题的答案就是先后——所以组按优先级排（会赢的在前），号只写在根上。
 */

import type { SkillEntry } from '@/plugins/services.js';
import type { SkillRoot } from '@/plugins/sph-skills/scan.js';
import type { ReportBlock, ReportItem, ReportTab } from '@/plugins/sph-tui/report/doc.js';
import { oneLine, shortenRoot } from '@/plugins/sph-tui/report/text.js';

export interface SkillsTabInput {
	catalog: readonly SkillEntry[];
	warnings: readonly string[];
	/** 根清单（顺序即覆盖顺序，后者覆盖前者）。带分级，组标题里要写 `User` / `Project`。 */
	roots: readonly SkillRoot[];
}

export function skillsTab(input: SkillsTabInput): ReportTab {
	const { catalog, warnings, roots } = input;
	const blocks: ReportBlock[] = [];

	const paths = roots.map((root) => root.path);
	const levelOf = new Map(roots.map((root) => [root.path, root.level]));
	// 根在清单里的位置就是优先级：显示时倒过来数，`#1` 是赢的那个。
	const rankOf = (root: string): number => paths.lastIndexOf(root);
	const byPriority = <T>(entries: readonly T[], root: (entry: T) => string): T[] => {
		const sorted = [...entries];
		sorted.sort((left, right) => rankOf(root(right)) - rankOf(root(left)));
		return sorted;
	};

	const grouped = new Map<string, SkillEntry[]>();
	for (const skill of catalog) {
		const bucket = grouped.get(skill.root);
		if (bucket === undefined) grouped.set(skill.root, [skill]);
		else bucket.push(skill);
	}
	const ordered = byPriority([...grouped.entries()], (entry) => entry[0]);

	if (catalog.length === 0) {
		// 空态一句话（投影层会居中并留白）：整段的「技能是什么、放哪」由下面的根清单自己回答。
		blocks.push({ kind: 'empty', text: 'No skills found.' });
	}

	// 每个有货的来源都画组标题，哪怕只有一个：它回答的是「这些技能从哪来」——那正是打开这份
	// 报告要确认的事，不能因为「没有竞争」就省掉。
	ordered.forEach(([root, skills]) => {
		const level = levelOf.get(root);
		const items: ReportItem[] = skills.map((skill): ReportItem => ({
			key: skill.name,
			label: { text: skill.name, bold: true },
			// 说明与入口路径退成明细：列表因此是一行一个技能名，扫得动；说明那种成段的文字留在列表里
			// 会把二十来个技能铺成几十行，反而谁也看不见。明细点开就留着，看哪个点哪个。
			fields: [
				{ value: oneLine(skill.description) },
				{
					// sph 真正会读的字段：决定这个技能是否出现在 `/` 菜单里（interactive-mode 查它）。
					// SKILL.md 里的 `allowed-tools` 之类**不显示**——`skill` 工具把整个文件原样交给模型，
					// 宿主不执行任何工具限制，显示出来会被读成「这个技能只能用这些工具」。
					key: 'user-invocable',
					value: skill.userInvocable === true ? 'yes' : 'no',
				},
				{ key: 'path', value: oneLine(shortenRoot(skill.path)) },
			],
		}));
		blocks.push({
			kind: 'group',
			group: {
				key: root,
				// 组名 = 来源 + 数量（`Project Skills (3 skills)`）：路径不进标题，它归下面那份 Sources scanned。
				// 数量走 countNoun 后缀而不是自己拼：单复数、检索时的 `(命中/总数)` 都归那套规则管。
				label: level === undefined ? 'Skills' : `${level} Skills`,
				countNoun: 'skills',
				items,
			},
		});
	});

	if (roots.length > 0) {
		// 扫过的每个根都列出来（含没货的）——它回答的是「我放了文件怎么没出现」，那要照着路径
		// 一条条核对。读法与 MCP 的 Sources scanned 一致：可折叠、缺省收起，状态跟在说明列。
		blocks.push({
			kind: 'group',
			group: {
				key: 'sources',
				label: 'Sources scanned',
				countNoun: 'roots',
				// 辅助组：根清单不是本 tab 的清点对象（技能才是），检索时整组退场——
				// 否则搜一个词会把五个空目录一并列出来，真命中反被淹掉。
				auxiliary: true,
				items: byPriority(roots, (root) => root.path).map((root): ReportItem => {
					const found = grouped.get(root.path)?.length ?? 0;
					return {
						key: root.path,
						label: [
							{ text: `${root.level} — `, tone: 'muted' },
							// 用户级根一律在主目录下，缩成 `~\.agents\skills`；项目级根写全路径——
							// 它回答的是「哪个工作区的根」，缩了就答不出。
							{ text: root.level === 'User' ? shortenRoot(root.path) : root.path, tone: 'code' },
						],
						description: found === 0 ? 'empty' : `found — ${found} skill${found === 1 ? '' : 's'}`,
					};
				}),
			},
		});
	}

	if (warnings.length > 0) {
		const items: ReportItem[] = warnings.map((warning, index) => ({
			key: `warning-${index}`,
			label: oneLine(warning),
			tone: 'warning',
		}));
		blocks.push({
			kind: 'group',
			group: { key: '__warnings', label: 'Warnings', collapsible: false, items },
		});
	}

	return {
		id: 'skills',
		label: 'Skills',
		blocks,
		empty: 'No skills match that.',
	};
}
