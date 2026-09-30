/**
 * 报告的投影：把一块报告（检索、折叠之后）拍平成列表行。
 *
 * 只读纯函数——不碰选中、不回写状态，同样的输入永远得到同样的行。事件层先算出
 * 「检索了什么、谁开着」，渲染层只负责画；渲染路径里不再有任何数据派生。
 *
 * 宽度是投影的入参而不是渲染时的细节：`prose` / `code` 块要按可用宽度换行，只有
 * 外壳知道每帧的可用宽度。宽度没变时投影结果可以整表复用（弹窗层拿 key 判断）。
 */

import { Markdown } from '@/tui/index.js';
import type { GroupRow } from '@/tui/widgets/group-list.js';
import { getMarkdownTheme, theme } from '@/plugins/sph-tui/theme/theme.js';
import { type FilteredTab } from './filter.js';
import {
	type ReportBlock,
	type ReportGroup,
	type ReportItem,
	type ReportTab,
	type RichText,
	groupCountSuffix,
	plainText,
} from './doc.js';
import type { FoldState } from './fold.js';

/** 行内语气 → 上色。色名取自 Markdown 主题的同义档，报告与散文读起来是一个体系。 */
function paintSegment(segment: { text: string; tone?: string; bold?: boolean }): string {
	const painted =
		segment.tone === 'code'
			? theme.bold(theme.fg('mdCode', segment.text))
			: segment.tone === 'muted'
				? theme.fg('muted', segment.text)
				: segment.tone === 'warn'
					? theme.fg('warning', segment.text)
					: segment.tone === 'error'
						? theme.fg('error', segment.text)
						: segment.text;
	return segment.bold === true ? theme.bold(painted) : painted;
}

/** 富文本 → 上色串。分组头、条目、尾列都从这里拿最终形态。 */
export function paintRich(text: RichText): string {
	if (typeof text === 'string') return text;
	if ('text' in text) return paintSegment(text);
	return text.map(paintSegment).join('');
}

/** 条目整行的语气色：危险红、警告橙；红黄是安全语义，不用在装饰上。 */
function itemTone(item: ReportItem): ((text: string) => string) | undefined {
	if (item.tone === 'danger') return (text) => theme.fg('error', text);
	if (item.tone === 'warning') return (text) => theme.fg('warning', text);
	return undefined;
}

/** 一条条目 → 主行 + 灰注脚行（注脚只在组展开时出现，折叠交给投影：收起的组不产条目行）。 */
function itemRows(item: ReportItem, indent: number, expanded: boolean): GroupRow[] {
	const tone = itemTone(item);
	const label = paintRich(item.label);
	const description = item.description === undefined ? '' : paintRich({ text: plainText(item.description), tone: 'muted' });
	const main: GroupRow = {
		key: item.key,
		kind: 'item',
		indent,
		text: description === '' ? label : `${label}  ${description}`,
		trailing: item.trailing === undefined ? undefined : paintRich(item.trailing),
	};
	if (tone !== undefined) {
		// 整行语气优先于行内色：条目名上的行内码蓝会冲淡危险红，危险行让整行都红。
		const text = item.description === undefined ? plainText(item.label) : `${plainText(item.label)}  ${plainText(item.description)}`;
		main.text = tone(text);
		if (item.trailing !== undefined) main.trailing = tone(plainText(item.trailing));
	}
	if (!expanded || item.notes === undefined || item.notes.length === 0) return [main];
	return [
		main,
		...item.notes.map((note): GroupRow => ({ key: `${item.key}::note`, kind: 'note', indent: indent + 1, text: paintRich({ text: plainText(note), tone: 'muted' }), disabled: true })),
	];
}

/** 分组头 → 一行。折叠字形与缩进由列表画，这里只给文字与计数。 */
function groupRow(group: ReportGroup, hit: number, total: number, expanded: boolean): GroupRow {
	const label = theme.bold(plainText(group.label));
	const suffix = groupCountSuffix(group, hit, total);
	return {
		key: group.key,
		kind: 'group',
		expanded,
		text: suffix === null ? label : `${label} ${theme.fg('muted', suffix)}`,
	};
}

/** prose / code 块 → 若干灰注脚行。Markdown 渲染后再逐行接入（它自己管换行与上色）。 */
function proseRows(block: Extract<ReportBlock, { kind: 'prose' | 'code' }>, width: number): GroupRow[] {
	const body = block.kind === 'code' ? '```' + (block.language ?? '') + '\n' + block.text + '\n```' : block.text;
	const rendered = new Markdown(body, 0, 0, getMarkdownTheme(), {
		color: (content: string) => theme.fg('mdText', content),
	}).render(Math.max(1, width));
	return rendered.map((line, index): GroupRow => ({ key: `::prose-${index}`, kind: 'note', text: line, disabled: true }));
}

/**
 * 投影一份报告。
 *
 * 顺序即 blocks 的声明顺序：caption 是行间的灰字说明，穿插在组之间时位置不能被搬到顶部。
 * 检索时 caption / prose / code 整体退场（`filterTab` 已经只留下命中的组），空态在这里兜底。
 */
export function projectReport(
	tab: ReportTab,
	filtered: FilteredTab,
	fold: FoldState,
	width: number,
): GroupRow[] {
	if (filtered.filtering && filtered.hits === 0) {
		return [{ key: '::empty', kind: 'note', text: theme.fg('muted', tab.empty), disabled: true }];
	}

	const rows: GroupRow[] = [];
	for (const block of filtered.blocks) {
		if (block.kind === 'caption') {
			rows.push({ key: `::caption-${rows.length}`, kind: 'note', text: theme.fg('muted', plainText(block.text)), disabled: true });
			continue;
		}
		if (block.kind === 'prose' || block.kind === 'code') {
			if (!filtered.filtering) rows.push(...proseRows(block, width));
			continue;
		}
		const group = block.group;
		const count = filtered.counts.get(group.key) ?? { hit: group.items.length, total: group.items.length };
		const expanded = fold.isExpanded(tab.id, group, filtered.filtering);
		rows.push(groupRow(group, count.hit, count.total, expanded));
		if (expanded) {
			for (const item of group.items) rows.push(...itemRows(item, 1, true));
		}
	}
	return rows;
}
