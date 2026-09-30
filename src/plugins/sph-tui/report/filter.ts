/**
 * 报告的查询过滤。
 *
 * 只作用于条目：一句话说明（`caption`）、散文与代码块在检索时整体退场——它们不是可选内容，
 * 搜索时留着只会占掉一行命中区。
 *
 * 命中数按「命中/总数」报：sph 一贯给真实数字，不假装搜索结果就是清单的全部。
 */

import { fuzzyFilter } from '@/tui/input/fuzzy.js';
import { type ReportBlock, type ReportGroup, type ReportItem, type ReportTab, plainText } from './doc.js';

/** 一组的命中数与总数。 */
export interface GroupCount {
	hit: number;
	total: number;
}

export interface FilteredTab {
	/** 是否处于检索中。渲染层据此决定强制展开、以及用哪种空态文案。 */
	filtering: boolean;
	blocks: readonly ReportBlock[];
	counts: ReadonlyMap<string, GroupCount>;
	/** 命中条目总数（不含组标题本身）。为 0 且 `filtering` 时说明要显示空态。 */
	hits: number;
}

/**
 * 一条条目的可检索文本。
 *
 * 组标题也进检索范围：用户往往记得「在 User 那组里」而不记得技能名，而组标题里同时带着
 * 来源路径，按路径找也成立。
 */
function searchText(item: ReportItem, group: ReportGroup): string {
	const parts = [
		item.key,
		plainText(item.label),
		item.description === undefined ? '' : plainText(item.description),
		item.trailing === undefined ? '' : plainText(item.trailing),
		...(item.notes ?? []).map(plainText),
		plainText(group.label),
	];
	return parts.filter((part) => part !== '').join(' ');
}

/**
 * 按查询过滤一个 tab。
 *
 * 空查询原样返回：分组与组内顺序是业务算出来的优先级（同名技能谁赢、来源覆盖次序），
 * 模糊分没有资格覆盖它。只有真的在检索时才让相关度排序接管。
 */
export function filterTab(tab: ReportTab, query: string): FilteredTab {
	const counts = new Map<string, GroupCount>();
	const groupBlocks = tab.blocks.filter((block) => block.kind === 'group');
	const trimmed = query.trim();

	if (trimmed === '') {
		let total = 0;
		for (const block of groupBlocks) {
			const size = block.group.items.length;
			counts.set(block.group.key, { hit: size, total: size });
			total += size;
		}
		return { filtering: false, blocks: tab.blocks, counts, hits: total };
	}

	const blocks: ReportBlock[] = [];
	let hits = 0;
	for (const block of groupBlocks) {
		const group = block.group;
		const items = [...group.items];
		const matched = fuzzyFilter(items, trimmed, (item) => searchText(item, group));
		counts.set(group.key, { hit: matched.length, total: items.length });
		if (matched.length === 0) continue;
		hits += matched.length;
		blocks.push({ kind: 'group', group: { ...group, items: matched } });
	}

	return { filtering: true, blocks, counts, hits };
}
