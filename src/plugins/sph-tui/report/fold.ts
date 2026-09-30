/**
 * 分组折叠状态。
 *
 * 按 tab 分开存，弹窗关掉就丢：报告要反映的是「打开这一刻的真实状态」，把展开状态落进配置，
 * 只会让下次打开看到一个和当下无关的界面。
 *
 * 只记被显式改过的那几组，其余按组的默认值走。这样新增一个分组不必登记任何东西，
 * 也不会出现「默认值改了、存量状态还按老的来」这种只在老用户机器上复现的偏差。
 */

import type { ReportGroup } from './doc.js';

export class FoldState {
	/** tabId → (groupKey → 是否展开)，只含用户显式开合过的组。 */
	private readonly explicit = new Map<string, Map<string, boolean>>();

	/**
	 * 某一组当前是否展开。
	 *
	 * `forceExpand` 给检索用：命中的条目藏在收起的组里等于没搜到。它**只看不改**——
	 * 清空查询之后要回到用户自己摆的那个状态，而不是留下一地被搜索撑开的组。
	 */
	isExpanded(tabId: string, group: ReportGroup, forceExpand = false): boolean {
		if (forceExpand) return true;
		if (group.collapsible === false) return true;
		const recorded = this.explicit.get(tabId)?.get(group.key);
		if (recorded !== undefined) return recorded;
		return group.initiallyExpanded !== false;
	}

	/** 翻转某一组；返回翻转后的状态。 */
	toggle(tabId: string, group: ReportGroup): boolean {
		const next = !this.isExpanded(tabId, group);
		this.set(tabId, group.key, next);
		return next;
	}

	set(tabId: string, groupKey: string, expanded: boolean): void {
		const perTab = this.explicit.get(tabId);
		if (perTab === undefined) {
			this.explicit.set(tabId, new Map([[groupKey, expanded]]));
			return;
		}
		perTab.set(groupKey, expanded);
	}
}
