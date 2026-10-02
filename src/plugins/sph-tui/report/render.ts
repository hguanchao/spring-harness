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
import { visibleWidth, wrapTextWithAnsi } from '@/tui/text/utils.js';
import { GROUP_GUTTER, GROUP_INDENT } from '@/tui/widgets/group-list.js';
import type { GroupRow } from '@/tui/widgets/group-list.js';
import { getMarkdownTheme, theme } from '@/plugins/sph-tui/theme/theme.js';
import { type FilteredTab } from './filter.js';
import {
	type ReportBlock,
	type ReportGroup,
	type ReportItem,
	type ReportTab,
	type RichText,
	type TextTone,
	groupCountSuffix,
	plainText,
} from './doc.js';
import type { FoldState } from './fold.js';

/** 行内语气 → 上色。色名取自 Markdown 主题的同义档，报告与散文读起来是一个体系。
 *
 * `code` 语气默认**加粗**——那是散文里行内码的强调；字段取值（路径）要平着读，
 * 由 `paintMuted(…, codeBold = false)` 关掉。
 */
function paintSegment(segment: { text: string; tone?: string; bold?: boolean }, codeBold = true): string {
	const codePainted = (text: string): string =>
		codeBold ? theme.bold(theme.fg('mdCode', text)) : theme.fg('mdCode', text);
	const painted =
		segment.tone === 'code'
			? codePainted(segment.text)
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
	return text.map((segment) => paintSegment(segment)).join('');
}

/**
 * 富文本 → 上色串，没标语气的分段落回 muted。
 *
 * 说明与注脚默认退到灰——它们是「核对时才看」的次级信息；但分段可以点名别的语气，
 * 插件的加载警告要橙、权限被丢弃的说明也要橙，灰底里那一小段颜色才是要一眼扫到的。
 */
function paintMuted(text: RichText, fallback: TextTone = 'muted', codeBold = true): string {
	if (typeof text === 'string') return paintSegment({ text, tone: fallback }, codeBold);
	const segments = 'text' in text ? [text] : text;
	return segments.map((segment) => paintSegment({ ...segment, tone: segment.tone ?? fallback }, codeBold)).join('');
}

/**
 * 字段的**键**决定取值的角色。
 *
 * 这是「配色由结构回答」的落点：`path` / `target` 这类键的取值是要照抄进终端或编辑器的
 * 字面量，走行内码色；写数据的人不必再逐个字段标 `tone`——同一个键在各 tab 的画法自然一致。
 * 键之外的字段沿用 `muted`（核对时才看的次级信息）。
 *
 * 只收「取值恒为字面量」的键：`from` 这种来源描述、`user-invocable` 这种取值，都留在灰里。
 * 想给单条取值换角色，仍然可以在值里写分段（`{ text, tone }`），分段优先。
 */
const FIELD_TONES: Readonly<Record<string, TextTone>> = {
	path: 'code',
	target: 'code',
};

/** 条目整行的语气色：危险红、警告橙；红黄是安全语义，不用在装饰上。 */
function itemTone(item: ReportItem): ((text: string) => string) | undefined {
	if (item.tone === 'danger') return (text) => theme.fg('error', text);
	if (item.tone === 'warning') return (text) => theme.fg('warning', text);
	return undefined;
}

/** 标签与描述之间的间隔列数。 */
const ITEM_GAP = 2;

/**
 * 折行后每行描述至少要剩这么多列才值得折。
 *
 * 标签很长时（权限规则、`WebFetch(domain:…)` 这类）描述列会被挤到右边，再折就是每行一两个词
 * 的一长条——比截断更没法看。这种情况退回截断。
 */
const MIN_DESCRIPTION_COLUMNS = 12;

/** 条目正文（标签列）的起始列：条目固定一层缩进，加折叠字形空槽。 */
const ITEM_BODY_COLUMN = GROUP_INDENT + GROUP_GUTTER;

/**
 * 一组的标签列宽：取组内最宽标签，但**最多占正文的一半**。
 *
 * 不封顶的话，一个超长标签（长技能名、权限规则）会把整组的描述列一起推远：短标签行后面拖出
 * 一大片空白，描述列反被压成每行三两个词——比不对齐更难读。封顶之后超宽的那一行自己另起一列，
 * 是组内唯一的例外。
 */
function labelColumnsFor(items: readonly ReportItem[], width: number): number {
	const widest = items.reduce((max, item) => Math.max(max, visibleWidth(plainText(item.label))), 0);
	return Math.min(widest, Math.max(0, Math.floor((width - ITEM_BODY_COLUMN - ITEM_GAP) / 2)));
}

/**
 * 条目正文的起始列与描述列。
 *
 * `labelColumns` 是**同组内最宽的标签**：标签短的行补空格补到这一列，正文首字才成一条竖线。
 * 补到这一列为止，超宽的标签不再拉走正文——那已经不是对齐，是把整组的正文列推远。
 */
function bodyColumns(indent: number, label: string, labelColumns: number): { gapAfterLabel: number; textColumn: number } {
	const bodyColumn = indent * GROUP_INDENT + GROUP_GUTTER;
	const field = Math.max(visibleWidth(label), labelColumns);
	return { gapAfterLabel: field - visibleWidth(label) + ITEM_GAP, textColumn: bodyColumn + field + ITEM_GAP };
}

/**
 * 条目有没有可展开的明细：与 {@link detailRows} 的空判同一把尺子（取值全空的字段不算内容）。
 *
 * 没有明细的条目（命令清单、键位清单、权限层）不画光标字形——那条字形槽说的是「能展开」，
 * 而它们展开不出任何东西，画了就是空承诺。判断与明细同一把尺子，两者才不会各说各话。
 */
function hasDetail(item: ReportItem): boolean {
	return (item.fields ?? []).some((field) => visibleWidth(plainText(field.value)) > 0);
}

/**
 * 选中条目的明细：**一行一项，取值紧跟在键后一个空格**，取值折行的续行挂在取值列下。
 *
 * 不做跨字段键列对齐：`path` 这种短键后面垫出一大截空白，取值反而像另起一列（grok 的插件
 * 面板就是这么排的，远得让人找不到值）。值贴着键读，续行仍与本行取值取齐。
 *
 * 整条明细都不可选（`disabled`）：它是条目的附加内容，↑↓ 只在条目之间走，不会走进明细里。
 */
function detailRows(item: ReportItem, width: number): GroupRow[] {
	const tone = itemTone(item);
	const fields = (item.fields ?? [])
		.map((field) => {
			// 键先定角色（见 FIELD_TONES），整行语气（危险红/警告橙）压过它。
			const role = field.key === undefined ? 'muted' : (FIELD_TONES[plainText(field.key)] ?? 'muted');
			return {
				key: field.key === undefined ? undefined : `${paintRich(field.key)}:`,
				// 行内码的加粗是散文的强调；字段值（路径这类要照抄的字面量）要平着读。
				value: tone === undefined ? paintMuted(field.value, role, false) : tone(plainText(field.value)),
			};
		})
		.filter((field) => visibleWidth(field.value) > 0);
	if (fields.length === 0) return [];

	// 明细只比条目名深一层（Grok 的插件面板就是这个量）：块是这条条目的附加内容，不是另起一列。
	// 比正文列再深两格就够了；缩进越大，取值能用的列越少，长清单反而折得更多。
	const textColumn = 1 * GROUP_INDENT + GROUP_GUTTER + GROUP_INDENT;
	const rows: GroupRow[] = [];
	fields.forEach((field, index) => {
		const valueColumn = field.key === undefined ? textColumn : textColumn + visibleWidth(field.key) + 1;
		const chunks = wrapTextWithAnsi(field.value, Math.max(1, width - valueColumn));
		rows.push({
			key: `${item.key}::field-${index}`,
			kind: 'note',
			textIndent: textColumn,
			text: field.key === undefined ? chunks[0]! : `${field.key} ${chunks[0]!}`,
			disabled: true,
		});
		for (const [chunkIndex, chunk] of chunks.slice(1).entries()) {
			rows.push({
				key: `${item.key}::field-${index}::wrap-${chunkIndex}`,
				kind: 'note',
				textIndent: valueColumn,
				text: chunk,
				disabled: true,
			});
		}
	});
	return rows;
}

/**
 * 一条条目 → 主行（可带折行续行的描述）+ 灰注脚行（注脚只在组展开时出现，折叠交给投影：收起的组不产条目行）。
 *
 * 描述不截断：放不下的部分折到续行，续行用 `textIndent` 对齐到本行的正文列。折回标签列会让
 * 续行读成另一条条目。明细（`fields`）不走这里——它只在条目被点开时由 `detailRows` 挂上；
 * 没有明细的条目连光标字形都不画（`expandable: false`，见 {@link hasDetail}）。
 */
function itemRows(
	item: ReportItem,
	indent: number,
	expanded: boolean,
	width: number,
	labelColumns: number,
	/** 明细开着的条目 key：这一条画 `›` 还是 `✦` 由它说，跟光标无关。 */
	openDetails?: ReadonlySet<string>,
): GroupRow[] {
	const tone = itemTone(item);
	const plainLabel = plainText(item.label);
	// 整行语气优先于行内色：条目名上的行内码蓝会冲淡危险红，危险行让整行都红。
	const label = tone === undefined ? paintRich(item.label) : tone(plainLabel);
	const plainDescription = item.description === undefined ? '' : plainText(item.description);
	const description =
		plainDescription === '' ? '' : tone === undefined ? paintMuted(item.description!) : tone(plainDescription);
	const trailing =
		item.trailing === undefined ? undefined : tone === undefined ? paintRich(item.trailing) : tone(plainText(item.trailing));

	const expandable = hasDetail(item);
	// 明细开着的条目画 `✦`：字形槽说的是「这一行开着」，不是「光标在这」（光标由整行底色说）。
	const open = openDetails?.has(item.key) === true;
	const rows: GroupRow[] = [];
	if (description === '') {
		rows.push({ key: item.key, kind: 'item', indent, text: label, trailing, expandable, expanded: open });
	} else {
		const { gapAfterLabel, textColumn } = bodyColumns(indent, label, labelColumns);
		// 续行与主行的描述共用一个列宽，这样折出来是一块，而不是逐行参差。
		// 尾列留在主行右侧，所以它也从这个列宽里扣掉。
		const reserve = trailing === undefined ? 0 : visibleWidth(trailing) + 1;
		const budget = width - textColumn - reserve;
		if (budget < MIN_DESCRIPTION_COLUMNS) {
			rows.push({
				key: item.key,
				kind: 'item',
				indent,
				text: `${label}${' '.repeat(gapAfterLabel)}${description}`,
				trailing,
				expandable,
				expanded: open,
			});
		} else {
			const chunks = wrapTextWithAnsi(description, budget);
			rows.push({
				key: item.key,
				kind: 'item',
				indent,
				text: `${label}${' '.repeat(gapAfterLabel)}${chunks[0]!}`,
				trailing,
				expandable,
				expanded: open,
			});
			for (const [chunkIndex, chunk] of chunks.slice(1).entries()) {
				rows.push({
					key: `${item.key}::wrap-${chunkIndex}`,
					kind: 'note',
					textIndent: textColumn,
					text: chunk,
					disabled: true,
				});
			}
		}
	}
	if (!expanded || item.notes === undefined || item.notes.length === 0) return rows;
	return [
		...rows,
		...item.notes.map((note): GroupRow => ({ key: `${item.key}::note`, kind: 'note', indent: indent + 1, text: paintMuted(note), disabled: true })),
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
		foldable: group.collapsible !== false,
		text: suffix === null ? label : `${label} ${theme.fg('muted', suffix)}`,
	};
}

/** prose / code 块 → 若干灰注脚行。Markdown 渲染后再逐行接入（它自己管换行与上色）。 */
function proseRows(block: Extract<ReportBlock, { kind: 'prose' | 'code' }>, width: number, blockIndex: number): GroupRow[] {
	const body = block.kind === 'code' ? '```' + (block.language ?? '') + '\n' + block.text + '\n```' : block.text;
	const rendered = new Markdown(body, 0, 0, getMarkdownTheme(), {
		color: (content: string) => theme.fg('mdText', content),
	}).render(Math.max(1, width));
	// key 带上块序号：多个散文块的行号各自从 0 数起，不带块号会撞 key。
	return rendered.map((line, index): GroupRow => ({ key: `::prose-${blockIndex}-${index}`, kind: 'note', text: line, disabled: true }));
}

/**
 * 空态：一句灰字左右居中，上下各留 {@link EMPTY_MARGIN_ROWS} 行空白。
 *
 * 空态不是正文的一条：贴着搜索行说「没有」会读成正文的开头，而它其实是「这一屏没内容」。
 * 留白与居中一并交给投影——宽度只有这里知道，块本身只管说那句话。
 */
function emptyRows(text: RichText, width: number): GroupRow[] {
	const painted = paintMuted(text);
	// 居中按**可见宽度**算：painted 带 ANSI，用 visibleWidth 而不是 length。
	const pad = ' '.repeat(Math.max(0, Math.floor((width - visibleWidth(painted)) / 2)));
	const blank = (key: string): GroupRow => ({ key, kind: 'note', text: '', disabled: true });
	return [
		...Array.from({ length: EMPTY_MARGIN_ROWS }, (_, index) => blank(`::empty-lead-${index}`)),
		{ key: '::empty', kind: 'note', text: `${pad}${painted}`, disabled: true },
		...Array.from({ length: EMPTY_MARGIN_ROWS }, (_, index) => blank(`::empty-tail-${index}`)),
	];
}

/** 空态上下各留几行空白。矮终端上这两行也吃掉内容高度，所以是个小数字。 */
const EMPTY_MARGIN_ROWS = 2;

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
	/**
	 * 明细开着的条目 key：开着的都挂着，互不影响（点开第二条不会关掉第一条）。
	 *
	 * 从前这里收的是「光标停在哪条」——明细跟着光标走，读法就成了「看一条关一条」。
	 */
	openDetails?: ReadonlySet<string>,
): GroupRow[] {
	if (filtered.filtering && filtered.hits === 0) return emptyRows(tab.empty, width);

	const rows: GroupRow[] = [];
	for (const [blockIndex, block] of filtered.blocks.entries()) {
		if (block.kind === 'caption') {
			// 说明句按宽度折行，不截断：它是一句完整的话，`…` 切掉后半句之后读不出结论，
			// 而这块地方本来就空着——省下的那一行不值得拿意思去换。
			for (const [lineIndex, line] of wrapTextWithAnsi(paintMuted(block.text), width).entries()) {
				rows.push({ key: `::caption-${blockIndex}-${lineIndex}`, kind: 'note', text: line, disabled: true });
			}
			continue;
		}
		if (block.kind === 'empty') {
			rows.push(...emptyRows(block.text, width));
			continue;
		}
		if (block.kind === 'prose' || block.kind === 'code') {
			if (!filtered.filtering) rows.push(...proseRows(block, width, blockIndex));
			continue;
		}
		const group = block.group;
		const count = filtered.counts.get(group.key) ?? { hit: group.items.length, total: group.items.length };
		const expanded = fold.isExpanded(tab.id, group, filtered.filtering);
		rows.push(groupRow(group, count.hit, count.total, expanded));
		if (expanded) {
			// 条目正文的首字对齐成一条竖线：组内标签统一补到最宽者那一列。
			const labelColumns = labelColumnsFor(group.items, width);
				for (const item of group.items) {
					rows.push(...itemRows(item, 1, true, width, labelColumns, openDetails));
				if (openDetails?.has(item.key) === true) rows.push(...detailRows(item, width));
			}
		}
	}
	return rows;
}
