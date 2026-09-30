/**
 * 报告弹窗：唯一的多 tab 只读报告宿主（/skills、/plugins、/help……）。
 *
 * 报告此前是「拼好的 markdown 字符串」塞进只读文本框：没有 tab、没有搜索、没有折叠，
 * 想找一条要翻几屏。这个宿主把同一份外壳升级成结构化的：tab 栏 + 搜索行 + 可折叠分组
 * 列表 + 框内 footer，而每个 tab 只是注册表里的一份 `ReportTab` 数据。
 *
 * 与四类弹窗（dialogs.ts）刻意不同、且不同得有理由的地方：
 * - **直角框**：多 tab 的顶边要给 tab 栏让位，圆角框嵌不下一行 tab；方角与 markdown
 *   表格的 `┌┐└┘` 同源，不是新语汇。单 tab 时顶边仍嵌标题，观感与旧报告弹窗衔接。
 * - **盒子吃满行预算 + 垂直居中**：报告是「看一块全貌」的模态，贴顶缩高会像随手弹出的
 *   提示。四类弹窗保持原样（它们是「就地展开的一层」）。
 * - **footer 在框内居中**：提示项带丢弃优先级，窄终端先丢次要项、`Esc close` 永远在场
 *   ——这是把 dialogs.ts 里那份手写键名白名单（compactHint）的意图变成数据。
 *
 * 键盘：`Tab` 切 tab（懒构造，切到谁才建谁）、`/` 搜索、`↑↓` 移动、`Enter` 开合组、
 * `Esc` 逐级退（清搜索 → 退搜索 → 关弹窗）。
 */

import { matchesKey, type Component, type OverlayHandle, type SizeValue, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from '@/tui/index.js';
import { renderRoundedBox, visibleWidth } from '@/tui/text/utils.js';
import { GroupList } from '@/tui/widgets/group-list.js';
import { TabBar } from '@/tui/widgets/tab-bar.js';
import { fillDialogSurface, rowBudget } from '@/plugins/sph-tui/dialogs.js';
import { getGroupListTheme, theme } from '@/plugins/sph-tui/theme/theme.js';
import type { ReportAction, ReportTab } from './doc.js';
import { type FilteredTab, filterTab } from './filter.js';
import { FoldState } from './fold.js';
import { projectReport } from './render.js';
import { type ReportContext, type ReportTabSpec, findReportTab } from './registry.js';

/** 与 dialogs.ts 同源的内边距：正文贴着边框会像「文字要溢出盒子」。 */
const PAD_X = 2;

/** 搜索态的块光标：reverse 一格，跟终端的光标观感对齐，不依赖浮层的硬件光标通路。 */
const CURSOR = '\x1b[7m \x1b[27m';

/** 全局动作。dropPriority 大的先丢；Esc 是 0，最后才轮到它。 */
const GLOBAL_ACTIONS: readonly ReportAction[] = [
	{ key: '↑↓', label: 'move', dropPriority: 3 },
	{ key: 'Enter', label: 'fold', dropPriority: 2 },
	{ key: '/', label: 'search', dropPriority: 1 },
	{ key: 'Tab', label: 'tab', dropPriority: 4 },
	{ key: 'Esc', label: 'close', dropPriority: 0 },
];

/** footer 一项的渲染宽：`key label` + 两格分隔。 */
function actionWidth(action: ReportAction): number {
	return visibleWidth(action.key) + 1 + visibleWidth(action.label);
}

/**
 * footer 居中行：按丢弃优先级裁到预算内。
 *
 * 丢弃从 priority 最大者开始——次要动词先让位，键名（尤其 Esc）压轴。全部放不下时
 * 返回空串：关不掉的弹窗比没有提示更糟，但一行都放不下时提示本身就成了祸害。
 */
function renderFooter(actions: readonly ReportAction[], budget: number): string {
	const parts = actions.map((action) => `${theme.bold(theme.fg('text', action.key))} ${theme.fg('muted', action.label)}`);
	const widths = actions.map(actionWidth);
	const separators = actions.map((_, index): number => (index === 0 ? 0 : 3)); // ` · `
	let total = widths.reduce((sum, width) => sum + width, 0) + separators.reduce((sum, width) => sum + width, 0);
	const order = actions.map((_, index) => index).sort((left, right) => actions[right]!.dropPriority - actions[left]!.dropPriority);
	const dropped = new Set<number>();
	for (const index of order) {
		if (total <= budget) break;
		if (actions[index]!.dropPriority === 0) break; // Esc 压轴，不再丢
		dropped.add(index);
		total -= widths[index]! + separators[index]!;
	}
	const kept = actions.map((_, index) => index).filter((index) => !dropped.has(index));
	if (kept.length === 0 || total > budget) return '';
	const rendered = kept.map((index) => (separators[index] === 0 ? parts[index]! : ` · ${parts[index]}`));
	const line = rendered.join('');
	const pad = Math.max(0, Math.floor((budget - total) / 2));
	return ' '.repeat(pad) + line;
}

/**
 * 报告弹窗本体。键盘、鼠标、渲染都在这一层；tab 数据与投影（render.ts）都是纯函数，
 * 这里不含任何数据派生逻辑。
 *
 * 导出只为测试：直接构造即可驱动（预算是入参，不依赖 TUI）。
 */
export class ReportDialog implements Component {
	private readonly specs: readonly ReportTabSpec[];
	private readonly context: ReportContext;
	private readonly budget: () => number;
	private readonly fold = new FoldState();
	private readonly list: GroupList;

	/** 已建好的 tab（本次打开内缓存，关闭即丢）。 */
	private readonly built = new Map<string, ReportTab>();
	private activeId: string;
	private query = '';
	private searching = false;
	/** 折叠变化自增：投影缓存据此失效。 */
	private foldRevision = 0;

	private tabBar: TabBar | undefined;
	/** 上一次投影的 key：tab、查询、宽度、折叠任一变了才重投影、才 setRows。 */
	private projectionKey = '';
	private lastFiltered: FilteredTab | undefined;
	private listTop = 0;
	private listRows = 0;
	private tabRows = 0;
	private lastWidth = 0;

	onClose: (() => void) | undefined;

	constructor(specs: readonly ReportTabSpec[], initialId: string, context: ReportContext, budget: () => number) {
		this.specs = specs;
		this.context = context;
		this.budget = budget;
		this.activeId = initialId;
		this.list = new GroupList([], getGroupListTheme(), 10);
		this.list.onActivate = (row) => this.activate(row.key, row.expanded === true);
	}

	/** 落点 tab；没建过就现在建（懒构造的唯一入口）。 */
	private tab(): ReportTab {
		const cached = this.built.get(this.activeId);
		if (cached !== undefined) return cached;
		const spec = this.specs.find((candidate) => candidate.id === this.activeId) ?? findReportTab(this.activeId);
		const tab = spec.build(this.context);
		this.built.set(this.activeId, tab);
		return tab;
	}

	private switchTo(id: string): void {
		if (id === this.activeId) return;
		this.activeId = id;
		this.query = '';
		this.searching = false;
		this.projectionKey = ''; // 新表强制重投影（setRows 的选中锚定按 key 找回）
	}

	/** Enter：组头开合；条目不做事——sph 有意把「看清单」和「执行」拆开。 */
	private activate(key: string, expanded: boolean): void {
		const row = this.list.selectedRow();
		if (row === undefined || row.kind !== 'group' || row.key !== key) return;
		this.fold.set(this.activeId, key, !expanded);
		this.foldRevision += 1;
	}

	/** 事件层重投影（键盘路径）；渲染路径用缓存的行表。 */
	private refresh(): void {
		const width = this.lastWidth;
		if (width <= 0) return;
		this.projectionKey = '';
		this.projectIfNeeded(width);
	}

	/** 投影 key 变了才重算并 setRows；否则 GroupList 自己的选中/悬停原样保留。 */
	private projectIfNeeded(width: number): void {
		const key = `${this.activeId}|${this.query}|${width}|${this.foldRevision}`;
		if (key === this.projectionKey) return;
		const tab = this.tab();
		const filtered = filterTab(tab, this.query);
		this.lastFiltered = filtered;
		this.list.setRows(projectReport(tab, filtered, this.fold, Math.max(1, width - 2 - PAD_X * 2)));
		this.projectionKey = key;
	}

	invalidate(): void {
		this.projectionKey = '';
	}

	handleInput(data: string): void {
		if (matchesKey(data, 'escape')) {
			if (this.searching && this.query !== '') {
				this.query = '';
				this.refresh();
				return;
			}
			if (this.searching) {
				this.searching = false;
				return;
			}
			this.onClose?.();
			return;
		}
		if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
			if (this.specs.length < 2) return;
			const index = this.specs.findIndex((spec) => spec.id === this.activeId);
			const next = matchesKey(data, 'shift+tab')
				? (index - 1 + this.specs.length) % this.specs.length
				: (index + 1) % this.specs.length;
			this.switchTo(this.specs[next]!.id);
			return;
		}
		if (matchesKey(data, 'up')) {
			this.list.move(-1, true);
			return;
		}
		if (matchesKey(data, 'down')) {
			this.list.move(1, true);
			return;
		}
		if (matchesKey(data, 'pageUp')) {
			this.list.page(-Math.max(1, this.listMaxVisible() - 1));
			return;
		}
		if (matchesKey(data, 'pageDown')) {
			this.list.page(Math.max(1, this.listMaxVisible() - 1));
			return;
		}
		if (matchesKey(data, 'home')) {
			this.list.selectFirst();
			return;
		}
		if (matchesKey(data, 'end')) {
			this.list.selectLast();
			return;
		}
		if (matchesKey(data, 'enter')) {
			const row = this.list.selectedRow();
			if (row?.kind === 'group') this.activate(row.key, row.expanded === true);
			return;
		}
		if (matchesKey(data, 'backspace') || matchesKey(data, 'ctrl+h')) {
			if (this.searching && this.query !== '') {
				this.query = this.query.slice(0, -1);
				this.refresh();
			}
			return;
		}
		if (matchesKey(data, 'ctrl+u')) {
			if (this.searching && this.query !== '') {
				this.query = '';
				this.refresh();
			}
			return;
		}
		// 可打印字符：搜索态进查询；否则 `/` 进入搜索（其余字符不抢焦点——报告的键都在修饰位）。
		if (data.length === 1 && data >= ' ' && data !== '\x7f') {
			if (this.searching) {
				this.query += data;
				this.refresh();
			} else if (data === '/') {
				this.searching = true;
			}
		}
	}

	private listMaxVisible(): number {
		return Math.max(1, this.budget() - 2 - this.tabRows - 2);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const interiorWidth = Math.max(1, this.lastWidth - 2 - PAD_X * 2);
		const interiorY = event.y - 1; // 第 0 行是上边框
		const x = event.x - 1 - PAD_X;

		if (event.type === 'wheel') {
			return this.list.handleMouse({ ...event, x, y: interiorY - this.listTop, width: interiorWidth, height: this.listRows });
		}

		if (event.type === 'press' || event.type === 'click') {
			// tab 行：命中哪栏切哪栏；间隙不算命中（TabBar 与渲染共用一份布局）。
			if (this.tabBar !== undefined && interiorY >= 0 && interiorY < this.tabRows) {
				const target = this.tabBar.hitTest(interiorWidth, interiorY, x);
				if (target !== undefined) {
					this.switchTo(this.specs[target]!.id);
					return { handled: true, render: true, focus: true };
				}
				return { handled: true, render: false, focus: true };
			}
			// 搜索行：点一下就进搜索，光标到位。
			if (interiorY === this.tabRows) {
				if (!this.searching) this.searching = true;
				return { handled: true, render: true, focus: true };
			}
			return this.list.handleMouse({ ...event, x, y: interiorY - this.listTop, width: interiorWidth, height: this.listRows });
		}

		if (event.type === 'move' && interiorY >= this.listTop) {
			return this.list.handleMouse({ ...event, x, y: interiorY - this.listTop, width: interiorWidth, height: this.listRows });
		}
		return undefined;
	}

	render(width: number): string[] {
		this.lastWidth = width;
		const interiorWidth = Math.max(1, width - 2 - PAD_X * 2);
		this.projectIfNeeded(interiorWidth);

		const multi = this.specs.length >= 2;
		if (multi) {
			this.tabBar ??= new TabBar(
				this.specs.map((spec) => spec.label),
				{
					active: (text) => theme.bold(theme.fg('primary', text)),
					inactive: (text) => theme.fg('muted', text),
				},
			);
			const index = this.specs.findIndex((spec) => spec.id === this.activeId);
			this.tabBar.setActive(index);
		} else {
			this.tabBar = undefined;
		}

		const tabLines = this.tabBar?.render(interiorWidth) ?? [];
		this.tabRows = tabLines.length;

		const searchLine = this.renderSearchLine(interiorWidth);
		const divider = theme.fg('borderMuted', '─'.repeat(interiorWidth));

		// 列表拿走预算内其余的行：盒子吃满是「报告是模态」的一部分，短报告底部留白，
		// 顶边框/底边框/footer 的位置不随内容行数跳。内容不足预算时补空行撑满——
		// 空行也会被铺上弹层底色，正好是「固定高框 + 下方留白」的观感。
		const capacity = Math.max(1, this.budget() - 2 - tabLines.length - 1 - 1 - 1);
		this.list.setMaxVisible(capacity);
		const listLines = this.list.render(interiorWidth);
		const filler = Array.from({ length: Math.max(0, capacity - listLines.length) }, () => '');
		this.listTop = tabLines.length + 2; // tab 行 + 搜索行 + 分隔线
		this.listRows = listLines.length;

		const actions = this.searching
			? [
					{ key: '↑↓', label: 'move', dropPriority: 3 },
					{ key: 'Esc', label: 'back', dropPriority: 0 },
				]
			: [...(this.tab().actions ?? []), ...GLOBAL_ACTIONS];
		const footerLine = renderFooter(actions, interiorWidth);

		const lines = [...tabLines, searchLine, divider, ...listLines, ...filler, footerLine].map((line) => `${' '.repeat(PAD_X)}${line}`);
		const scrollInfo = this.list.getScrollInfo();
		const boxed = renderRoundedBox({
			width,
			corners: 'square',
			// 多 tab 时身份由 tab 栏承担，顶边不嵌标题；单 tab 保留旧报告弹窗的标题观感。
			title: multi ? '' : ` ${this.tab().label} `,
			lines,
			bottomInfo: scrollInfo,
			frame: (text) => theme.fg('borderMuted', text),
			titlePaint: (text) => theme.bold(theme.fg('primary', text)),
		});
		return boxed.map((row) => fillDialogSurface(row, width, theme.bgSeq('bg')));
	}

	/** 搜索行：非激活是占位提示；激活显示查询与块光标，右侧报命中数。 */
	private renderSearchLine(interiorWidth: number): string {
		if (!this.searching) {
			return theme.fg('muted', '/ to search');
		}
		const left = `${theme.fg('text', '/')} ${theme.fg('text', this.query)}${CURSOR}`;
		if (this.query.trim() === '') return left;
		const hits = this.lastFiltered?.hits ?? 0;
		const right = theme.fg('muted', hits === 1 ? '1 hit' : `${hits} hits`);
		const pad = Math.max(1, interiorWidth - visibleWidth(left) - visibleWidth(right));
		return `${left}${' '.repeat(pad)}${right}`;
	}
}

/**
 * 打开报告弹窗。`tabId` 决定落点；一次只建一个 tab，切到谁才建谁。
 *
 * 一期只注册了 skills（灰度跑通），plugins / permissions / commands / keys 在 S3 逐个跟进
 * ——注册表与弹窗都按多 tab 写好，加 tab 不动这里。
 */
export function openReport(ui: TUI, tabId: string, context: ReportContext): Promise<void> {
	return new Promise((resolve) => {
		const specs = [findReportTab(tabId)];
		const maxHeight: SizeValue = '75%';
		const dialog = new ReportDialog(specs, tabId, context, () => rowBudget(ui, maxHeight));
		const handle: OverlayHandle = ui.showOverlay(dialog, {
			width: '60%',
			maxWidth: 120,
			maxHeight,
			// 不给 row：anchor center 生效——报告是模态，居中；「就地展开的一层」才贴顶。
			anchor: 'center',
			margin: 1,
			padX: 2,
			priority: 0,
		});
		let settled = false;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			handle.hide();
			resolve();
		};
		dialog.onClose = finish;
	});
}
