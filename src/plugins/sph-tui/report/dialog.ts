/**
 * 报告弹窗：唯一的多 tab 只读报告宿主（/skills、/plugins、/help……）。
 *
 * 报告此前是「拼好的 markdown 字符串」塞进只读文本框：没有 tab、没有搜索、没有折叠，
 * 想找一条要翻几屏。这个宿主把同一份外壳升级成结构化的：tab 栏 + 搜索行 + 可折叠分组
 * 列表 + 框内 footer，而每个 tab 只是注册表里的一份 `ReportTab` 数据。
 *
 * 与四类弹窗（dialogs.ts）刻意不同、且不同得有理由的地方：
 * - **顶边让位给 tab 栏**：多 tab 的顶边要嵌一行 tab，所以不嵌标题；单 tab 时顶边仍嵌标题，
 *   观感与旧报告弹窗衔接。（角字全屏统一是方角 `┌┐└┘`，与 markdown 表格同源，这里不再单说。）
 * - **盒子吃满行预算 + 垂直居中**：报告是「看一块全貌」的模态，贴顶缩高会像随手弹出的
 *   提示。四类弹窗保持原样（它们是「就地展开的一层」）。
 * - **footer 在框内居中**：提示项带丢弃优先级，窄终端先丢次要项、`Esc close` 永远在场
 *   ——「谁先让位」写成数据（dropPriority），不再需要一份手写的键名白名单。
 * - **头部分三段**：tab 栏 / 搜索行 / 面板，两两之间压一条分隔线。多 tab 时 tab 栏与搜索行
 *   挨着会读成「搜索属于当前 tab 的内容」，隔开才看得出搜索是整表范围的；单 tab 没有 tab 栏，
 *   搜索行上方就是顶边框，不再补线，免得双线。分隔线**满宽**贴到左右边框——它是界不是正文，
 *   PAD_X 那层正文留白不适用于它。
 *
 * 键盘：`Tab` 切 tab（懒构造，切到谁才建谁）、`/` 搜索、`↑↓` 移动、`Enter` 开合组、
 * `Esc` 逐级退（清查询 → 失焦 → 关弹窗）。
 *
 * 搜索框有焦点概念：`/` 或点它聚焦，`Enter`（输入完了）、`Esc`、点框外任一处都失焦。
 * **失焦不等于清空**——查询继续留在表上当过滤条件，搜索行照旧显示它，再按 `/` 接着改。
 */

import { matchesKey, type Component, type OverlayHandle, type SizeValue, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from '@/tui/index.js';
import { renderRoundedBox, visibleWidth } from '@/tui/text/utils.js';
import { GroupList } from '@/tui/widgets/group-list.js';
import { TabBar } from '@/tui/widgets/tab-bar.js';
import { errorMessage } from '@/util.js';
import { fillDialogSurface, rowBudget } from '@/plugins/sph-tui/dialogs.js';
import { getGroupListTheme, theme } from '@/plugins/sph-tui/theme/theme.js';
import type { ReportAction, ReportTab } from './doc.js';
import { type FilteredTab, filterTab } from './filter.js';
import { FoldState } from './fold.js';
import { projectReport } from './render.js';
import { REPORT_TABS, type ReportContext, type ReportTabSpec, findReportTab } from './registry.js';

/** 与 dialogs.ts 同源的内边距：正文贴着边框会像「文字要溢出盒子」。 */
const PAD_X = 2;

/** 搜索态的块光标：reverse 一格，跟终端的光标观感对齐，不依赖浮层的硬件光标通路。 */
const CURSOR = '\x1b[7m \x1b[27m';

/** 全局动作。dropPriority 大的先丢；Esc 是 0，最后才轮到它。 */
const GLOBAL_ACTIONS: readonly ReportAction[] = [
	{ key: '↑↓', label: 'move', dropPriority: 3 },
	{ key: 'Enter', label: 'open', dropPriority: 2 },
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
	/** 明细开着的条目 key，按 tab 分开存（与 {@link fold} 同款：本次打开内有效，关掉即丢）。 */
	private readonly openDetails = new Map<string, Set<string>>();
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
	/** 搜索行在框内的行号（0 基，不含上边框）：tab 栏下面隔一条线才是它。 */
	private searchRow = 0;
	/** 头部总行数：tab 栏 + 搜索行 + 它们之间的分隔线。列表偏移与预算都按它算。 */
	private headerRows = 0;
	private lastWidth = 0;

	/** 关闭回调：带上按下的动作键（没有就是普通关闭）。宿主靠它把「面板里按了什么」接过去。 */
	onClose: ((action?: string) => void) | undefined;
	/** 动作处理回调；设置后动作触发时保持报告浮层，由宿主叠加下一层 UI。 */
	onAction: ((action: string) => void | Promise<void>) | undefined;

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
		let tab: ReportTab;
		try {
			tab = spec.build(this.context);
		} catch (error) {
			// 单个数据源失败（文件读不到、宿主缺依赖）只砸自己这块：显示空态，别把整个
			// 弹窗拖垮——其余 tab 与关闭路径都还能用。
			tab = {
				id: spec.id,
				label: spec.label,
				blocks: [{ kind: 'prose', text: `This tab failed to load: ${errorMessage(error)}` }],
				empty: 'Nothing to show.',
			};
		}
		this.built.set(this.activeId, tab);
		return tab;
	}

	private switchTo(id: string): void {
		if (id === this.activeId) return;
		this.activeId = id;
		this.query = '';
		this.searching = false;
		// 立刻重投影，不能只作废 key 等下一帧：一次 stdin 读取里可能压着多个按键
		// （`StdinBuffer` 对同一 chunk 里的完整序列是同步派发的），中间没有渲染。
		// 此时 `activate` 拿到的是上一张表的行表，回车会去开合上一张表里的组。
		this.refresh();
	}

	/** 当前 tab 里明细开着的条目 key；没有就地建一个空集。 */
	private detailsOpen(): Set<string> {
		let set = this.openDetails.get(this.activeId);
		if (set === undefined) {
			set = new Set<string>();
			this.openDetails.set(this.activeId, set);
		}
		return set;
	}

	/**
	 * Enter / **双击**一行：组头开合它自己，条目开合它自己的明细（单击只移高亮）。
	 *
	 * 每行各开各的——点开第二条不会关掉第一条（明细从前跟光标走，读法就成了「看一条关一条」）。
	 * 没有可执行动作：sph 有意把「看清单」和「执行」拆开。
	 */
	private activate(key: string, expanded: boolean): void {
		const row = this.list.selectedRow();
		if (row === undefined || row.key !== key) return;
		if (row.kind === 'group') {
			this.fold.set(this.activeId, key, !expanded);
			this.foldRevision += 1;
			return;
		}
		// 没有明细的条目（命令清单、权限层）：开了也没内容，字形槽本来就是空的。
		if (row.kind !== 'item' || row.expandable === false) return;
		const open = this.detailsOpen();
		if (open.has(key)) open.delete(key);
		else open.add(key);
	}

	/** 事件层重投影（键盘路径）；渲染路径用缓存的行表。 */
	private refresh(): void {
		this.projectionKey = '';
		this.projectIfNeeded();
	}

	/**
	 * 内容宽度：框宽减两侧边框与左右留白。
	 *
	 * 投影宽度与渲染宽度必须同源：从前 `refresh()` 传框宽、`render()` 传内容宽，两次减去边框与
	 * 留白，投影就比实际渲染窄了 6 列——折行按错的宽度提前断，caption、条目描述、散文块全中招。
	 */
	private interiorWidth(): number {
		return Math.max(1, this.lastWidth - 2 - PAD_X * 2);
	}

	/**
	 * 投影 key 变了才重算并 setRows；否则 GroupList 自己的选中/悬停原样保留。
	 *
	 * **开着的明细也属于投影内容**，所以它们进 key：点开或收起一条，行表就得重算。光标不在 key
	 * 里——它只决定高亮，换光标不必重投影。`setRows` 按 key 锚定选中项，光标不会因为重投影跳走。
	 * 滚轮只挪视口、不动光标，因此也不会触发重投影。
	 */
	private projectIfNeeded(): void {
		const width = this.interiorWidth();
		if (this.lastWidth <= 0) return;
		const open = this.detailsOpen();
		const key = `${this.activeId}|${this.query}|${width}|${this.foldRevision}|${[...open].sort().join(',')}`;
		if (key === this.projectionKey) return;
		const tab = this.tab();
		const filtered = filterTab(tab, this.query);
		this.lastFiltered = filtered;
		this.list.setRows(projectReport(tab, filtered, this.fold, width, open));
		this.projectionKey = key;
	}

	invalidate(): void {
		this.projectionKey = '';
	}

	handleInput(data: string): void {
		if (matchesKey(data, 'escape')) {
			// 逐级退，一次只撤一层：清查询 → 失焦 → 关弹窗。写了一半按 Esc 结果整段弹窗没了，
			// 是最容易被读成「东西丢了」的行为。失焦之后查询还挂在表上，也是按这个次序撤。
			if (this.query !== '') {
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
			this.list.move(-1);
			return;
		}
		if (matchesKey(data, 'down')) {
			this.list.move(1);
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
			// 搜索态下 Enter 是「输入完了」：把焦点交还给列表，查询留在表上继续当过滤条件。
			// 此时回车去折叠选中行是误伤——手还在输入位上，列表里那行高亮不是他要动的东西。
			if (this.searching) {
				this.searching = false;
				return;
			}
			const row = this.list.selectedRow();
			if (row !== undefined) this.activate(row.key, row.expanded === true);
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
		// 可打印字符：搜索态进查询；否则先看是不是本 tab 声明的动作键（`m manage` 这种），
		// 再是 `/` 进搜索。其余字符不抢焦点——报告的键都在修饰位。
		if (data.length === 1 && data >= ' ' && data !== '\x7f') {
			if (this.searching) {
				this.query += data;
				this.refresh();
				return;
			}
				const action = this.tab().actions?.find((candidate) => candidate.key === data);
				if (action !== undefined) {
					if (this.onAction !== undefined) void this.onAction(action.key);
					else this.onClose?.(action.key);
					return;
				}
			if (data === '/') this.searching = true;
		}
	}

	/** 列表可见行数：与 render() 的 capacity 同式（原先比它多算一行，翻页会多跳一行）。 */
	private listMaxVisible(): number {
		return Math.max(1, this.budget() - 2 - this.headerRows - 1);
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
				this.searching = false;
				const target = this.tabBar.hitTest(interiorWidth, interiorY, x);
				if (target !== undefined) {
					this.switchTo(this.specs[target]!.id);
					return { handled: true, render: true, focus: true };
				}
				return { handled: true, render: true, focus: true };
			}
			// 搜索行：点一下就进搜索，光标到位。
			if (interiorY === this.searchRow) {
				if (!this.searching) this.searching = true;
				return { handled: true, render: true, focus: true };
			}
			// 搜索行以外的一律先失焦：这就是「点外面收焦点」。查询本身不丢，过滤照旧生效。
			const wasSearching = this.searching;
			this.searching = false;
			const result = this.list.handleMouse({ ...event, x, y: interiorY - this.listTop, width: interiorWidth, height: this.listRows });
			if (result === undefined) return wasSearching ? { handled: true, render: true, focus: true } : undefined;
			return wasSearching ? { ...result, render: true } : result;
		}

		if (event.type === 'move' && interiorY >= this.listTop) {
			return this.list.handleMouse({ ...event, x, y: interiorY - this.listTop, width: interiorWidth, height: this.listRows });
		}
		return undefined;
	}

	render(width: number): string[] {
		this.lastWidth = width;
		const interiorWidth = this.interiorWidth();
		this.projectIfNeeded();

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
		// 分隔线满宽：它是两段之间的「界」，贴到左右边框才读得成一条界。跟着正文缩进 PAD_X
		// 会把它降格成「一段内容」——和列表的缩进层级混在一起，界就不成界了。
		const divider = theme.fg('borderMuted', '─'.repeat(Math.max(1, width - 2)));
		// 正文行统一缩进 PAD_X，分隔线不缩进：缩进在这一层贴到行上，不再对整段统一加前缀。
		const indent = (line: string): string => `${' '.repeat(PAD_X)}${line}`;

		// 头部分三段：tab 栏 / 搜索行 / 面板。有 tab 栏时搜索行上下各压一条线，三段才各自成块；
		// 单 tab 报告没有 tab 栏，搜索行上方就是顶边框，再补一条会变成双线。
		const leadingDivider = tabLines.length > 0 ? [divider] : [];
		const headerLines = [...tabLines.map(indent), ...leadingDivider, indent(searchLine), divider];
		this.searchRow = tabLines.length + leadingDivider.length;
		this.headerRows = headerLines.length;

		// 列表拿走预算内其余的行：盒子吃满是「报告是模态」的一部分，短报告底部留白，
		// 顶边框/底边框/footer 的位置不随内容行数跳。内容不足预算时补空行撑满——
		// 空行也会被铺上弹层底色，正好是「固定高框 + 下方留白」的观感。
		const capacity = Math.max(1, this.budget() - 2 - headerLines.length - 1);
		this.list.setMaxVisible(capacity);
		const listLines = this.list.render(interiorWidth);
		const filler = Array.from({ length: Math.max(0, capacity - listLines.length) }, () => '');
		this.listTop = headerLines.length;
		this.listRows = listLines.length;

		const actions = this.searching
			? [
					{ key: '↑↓', label: 'move', dropPriority: 3 },
					{ key: 'Enter', label: 'done', dropPriority: 2 },
					{ key: 'Esc', label: 'back', dropPriority: 0 },
				]
			: [...(this.tab().actions ?? []), ...GLOBAL_ACTIONS];
		const footerLine = renderFooter(actions, interiorWidth);

		const lines = [...headerLines, ...listLines.map(indent), ...filler, indent(footerLine)];
		const boxed = renderRoundedBox({
			width,
			// 多 tab 时身份由 tab 栏承担，顶边不嵌标题；单 tab 保留旧报告弹窗的标题观感。
			title: multi ? '' : ` ${this.tab().label} `,
			lines,
			// 底边框右侧不报位置读数（`12/31`）：它是「第几条/共几条」，滚轮刚改成滚视口之后
			// 这个数跟眼前看到的位置对不上，反而误导；底边框留给 footer 提示那一行更干净。
			frame: (text) => theme.fg('borderMuted', text),
			titlePaint: (text) => theme.bold(theme.fg('primary', text)),
		});
		// 贴画布底而不是浮层面：报告是长驻的「一页」，四类弹窗才是浮起来的一层。
		// 这条分界写在 dialogs.ts 的底色规则里，改动要两边一起看。
		return boxed.map((row) => fillDialogSurface(row, width, theme.bgSeq('bg')));
	}

	/** 搜索行：`search:` 是字段名，后面跟查询；右侧报命中数。空查询且失焦时只剩字段名。 */
	private renderSearchLine(interiorWidth: number): string {
		// 字段名不随焦点消失：焦点只由块光标表示。写成 `/ 查询` 的话，聚焦那一瞬间标签会被
		// 一个斜杠顶掉，读起来像换了个控件，而不是「同一个框里开始输入」。
		const label = theme.fg('muted', 'search:');
		if (!this.searching && this.query === '') return label;
		// 失焦后查询还挂在表上当过滤条件：不显示就成了「列表莫名其妙少了几条」，
		// 也看不出该怎么撤。
		const left = `${label} ${theme.fg('text', this.query)}${this.searching ? CURSOR : ''}`;
		if (this.query.trim() === '') return left;
		const hits = this.lastFiltered?.hits ?? 0;
		const right = theme.fg('muted', hits === 1 ? '1 hit' : `${hits} hits`);
		const gap = interiorWidth - visibleWidth(left) - visibleWidth(right);
		// 放不下就让读数让位，绝不去挤左串——那是正在输入的查询，被截掉才是真丢东西。
		return gap >= 1 ? `${left}${' '.repeat(gap)}${right}` : left;
	}
}

/**
 * 打开报告弹窗。`tabId` 决定落点；一次只建落点这一个 tab，`Tab` 切到谁才建谁。
 *
 * specs 永远是全量的 REPORT_TABS：tab 栏要画出全部五栏，落点只决定初始高亮。
 * context 上没接数据源的 tab 会在切过去时显示失败空态（tab() 的 catch 分支），
 * 所以各命令的宿主应当把用得到的 getter 都接上。
 */
export function openReport(
	ui: TUI,
	tabId: string,
	context: ReportContext,
	options: { onAction?: (action: string) => void | Promise<void> } = {},
): Promise<string | undefined> {
	return new Promise((resolve) => {
		findReportTab(tabId); // 落点 id 未注册时在这里炸清楚，而不是渲染出一个高亮丢失的空弹窗
		const maxHeight: SizeValue = '75%';
		const dialog = new ReportDialog(REPORT_TABS, tabId, context, () => rowBudget(ui, maxHeight));
		const handle: OverlayHandle = ui.showOverlay(dialog, {
			width: '60%',
			maxWidth: 120,
			maxHeight,
			// 不给 row：anchor center 生效——报告是模态，居中；「就地展开的一层」才贴顶。
			anchor: 'center',
			margin: 1,
			padX: 2,
			priority: 0,
			// 弹窗失去焦点自动关闭：左键点在弹窗外 = 焦点走了，走 onClose 正常收尾（与 Esc 同一归宿）。
			onOutsidePress: () => dialog.onClose?.(),
		});
		let settled = false;
		// `action` 是面板里按下的动作键（如 MCP tab 的 `m`）；没按就是普通关闭。
		const finish = (action?: string): void => {
			if (settled) return;
			settled = true;
			handle.hide();
			resolve(action);
		};
		dialog.onClose = finish;
	dialog.onAction = options.onAction;
	});
}
