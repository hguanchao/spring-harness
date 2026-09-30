/**
 * Skills tab 的数据构造。
 *
 * 只做「数据 → 报告结构」，不碰 TUI：拉取数据留在命令里，排版留在渲染层。这样这份映射不用起
 * 整个界面就能测，而它恰恰最容易退化成空壳——列表为空、某个根没货、同名技能被两个根广告，
 * 都是真实会遇到、手测很容易漏的分支。
 *
 * 分组与排序沿用原样，因为它们是**覆盖语义**的直接映射：`scanSkills` 按根的顺序扫描，后者覆盖
 * 前者，所以「同名谁赢」这个问题的答案就是根的先后。显示时倒过来数号——`#1` 是会赢的那个，
 * 按全部六个根排号会让「只有一个来源」的机器看到 `#6`，像少了五条。
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

	// 说明压成一句 caption：它回答的是「这份清单怎么被用」，读过一次就有数；
	// 整段的机制讲解只对第一次打开的人有用，不该每次都占住列表上方的位置。
	blocks.push({ kind: 'caption', text: 'Matched by name+description; SKILL.md loads on use.' });

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
		blocks.push({
			kind: 'prose',
			text:
				'No skills found. A skill is a directory holding `SKILL.md` with `name` and `description` ' +
				'frontmatter — drop one in any root below and it is picked up on the next turn.',
		});
	}

	// 每个有货的来源都画组标题，哪怕只有一个：它回答的是「这些技能从哪来」——那正是打开这份
	// 报告要确认的事，不能因为「没有竞争」就省掉。
	ordered.forEach(([root, skills], index) => {
		const level = levelOf.get(root);
		const items: ReportItem[] = skills.map((skill): ReportItem => ({
			key: skill.name,
			label: { text: skill.name, tone: 'code', bold: true },
			description: oneLine(skill.description),
		}));
		blocks.push({
			kind: 'group',
			group: {
				key: root,
				label: `#${index + 1}  ${level === undefined ? '' : `${level} — `}${shortenRoot(root)}`,
				countNoun: 'skills',
				items,
			},
		});
	});

	const missed = roots.filter((root) => !grouped.has(root.path));
	if (catalog.length === 0) {
		// 空态这份清单和分组那份同一个方向：`1` 是会赢的那个（覆盖顺序里排最后的根）。
		const rootItems: ReportItem[] = byPriority(roots, (root) => root.path).map(
			(root, position): ReportItem => ({
				key: root.path,
				label: [{ text: `${position + 1}. ` }, { text: `${root.level} — ${root.path}`, tone: 'code' }],
			}),
		);
		blocks.push({
			kind: 'group',
			group: {
				key: '__roots',
				label: 'Roots · the lower number wins a name clash',
				collapsible: false,
				items: rootItems,
			},
		});
	} else {
		// 优先级规则收成 caption：组标题带上 # 号之后，它就是「怎么读这些号」的注释，不是正文。
		if (ordered.length > 1) {
			blocks.push({ kind: 'caption', text: 'A skill advertised by two roots resolves to the lower #.' });
			blocks.push({ kind: 'caption', text: 'Later roots override earlier ones.' });
		}
		if (missed.length > 0) {
			// 空根只占一句：它们回答的是「我放了文件怎么没出现」，逐个列出来又会吃掉半屏。
			const shown = missed.map((root) => shortenRoot(root.path)).join(' · ');
			blocks.push({
				kind: 'caption',
				text: `nothing found in ${missed.length} other root${missed.length === 1 ? '' : 's'}: ${shown}`,
			});
		}
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
