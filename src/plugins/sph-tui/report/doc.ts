/**
 * 报告的数据模型。
 *
 * 报告此前是「拼出来的 markdown 字符串」：分组、来源、计数、条目身份在拼串的那一刻就被压平，
 * 弹窗拿到的是一段不可再解析的文本，于是搜索、折叠、选中全都无从谈起。这里把它改成结构数据——
 * 数据层只回答「有哪些块、哪些组、哪些条目」，版式留给渲染层。
 *
 * 只有 `prose` / `code` 两种块例外：MCP 空态里那段可以直接抄下来的配置、`/help` 尾部的队列说明，
 * 本来就是散文，拆成条目只会把一段话切碎，它们继续走 Markdown。
 */

/** 行内语气。强调由类型表达，不靠往字符串里塞标记再解析回来。 */
export type TextTone = 'code' | 'muted' | 'warn' | 'error';

/*
 * 取色的规则（写数据的人按这条选 tone，别再逐个界面发明）：
 *
 * - `code`（蓝）= **能照抄进终端或编辑器的字面量**：命令、键位、路径、`target`、规则动作。
 *   名字不是字面量——条目主列（技能名、插件名、server 名、工具名）用加粗正文，不用蓝；
 *   一屏里的蓝越多，蓝就越不值钱。
 * - 不标 = 正文。表格的行标签（`user`、`Approval mode`）属于这类。
 * - `muted` = 核对时才看的次级信息：来源层、别名、根前缀。
 * - `warn` / `error` = 需要动作的告警与失败；红黄是安全语义，不做装饰。
 *
 * 字段取值的角色优先由**字段键**回答（见 render.ts 的 FIELD_TONES）：`path`/`target` 这类键
 * 的取值恒为字面量，写的人不必再标一遍。单条要例外时，在值里写分段（`{ text, tone }`）。
 */

export interface TextSegment {
  text: string;
  tone?: TextTone;
  bold?: boolean;
}

/**
 * 行内富文本：纯串、单个分段，或按语气分段。
 *
 * 报告里到处是「整句里少数几个词是行内码」的排版——`tools: mcp · services: mcp` 里的工具名、
 * `1. deny — Bash(rm -rf *)` 里的动作。用纯串就得引入转义（内容里的反引号会提前闭合代码段、
 * 换行会把一条撑成两行），用 markdown 又意味着要重新解析一遍。分段两头都避开。
 *
 * 单个分段允许直接给对象（不必写成单元素数组）：只有一个语气要标注是常态，为它加一层
 * `[ ]` 只会让每个条目都多一层括号。
 */
export type RichText = string | TextSegment | readonly TextSegment[];

/**
 * 明细里的一项：键（`tools` / `path`）与它的取值。
 *
 * 不给 `key` 就是一段**无键的段落**（技能说明就是这种）：它不参与键列对齐，按整行宽度折行——
 * 键值行与段落行在明细块里可以混排，顺序就是数组顺序。
 */
export interface ReportField {
	key?: RichText;
	value: RichText;
}

export interface ReportItem {
	/** 稳定身份：技能名、插件名、命令 id、键位文本。搜索、选中、测试都按它。 */
	key: string;
	/**
	 * 主列。
	 *
	 * 编号这类"顺序"信息属于数据，写在这里而不是交给列表的号槽：号槽算的是「可选行里的第几条」，
	 * 过滤之后编号会变，而权限规则的编号是**求值顺序**，正文里还有 `#3 ignored` 这样的句子引用它。
	 */
	label: RichText;
	description?: RichText;
	/**
	 * 逐项列出的明细（插件的 `tools` / `services` / `commands` 就是这种）。
	 *
	 * 与 `description` 的差别是**结构**：一句描述切开就变了意思，明细切开还是一项一项。
 * 渲染层据此把它排成「键列对齐、取值挂在其右」的明细块（折行的续行也挂在取值列下），
 * 并且只在条目被点开时挂出来——列表因此能一行一条地扫过去，而不是把每条的明细全铺开。
	 */
	fields?: readonly ReportField[];
	/** 右对齐尾列：来源、别名这类次级信息，放不下时整列舍弃。 */
	trailing?: RichText;
	/** 灰注脚（插件的入口路径这类），只在组展开时显示。 */
	notes?: readonly RichText[];
	/** 整行语气。危险项标红、失败项标橙，红黄橙是安全语义不是装饰。 */
	tone?: 'danger' | 'warning';
}

export interface ReportGroup {
	/** 折叠状态的身份，也是"这一组是什么"的稳定名字。 */
	key: string;
	label: RichText;
	/** 计数后缀的计量词（`skills` / `plugins`）。给了才渲染 `(n 词)`。 */
	countNoun?: string;
	/** 缺省可折叠；纯装饰性的分段给 false。 */
	collapsible?: boolean;
	/** 缺省收起。想让某组一打开就摊开（内容短、且每次都要看）才给 true。 */
	initiallyExpanded?: boolean;
	/**
	 * 附注组：不属于本 tab 的清点对象，检索时整组退场。
	 *
	 * caption / prose 天然不参与检索（`filterTab` 只收组），但有些内容得排成「标题 + 若干条」
	 * 才读得动，又同样是附注性质——空根清单就是：它回答「我放了文件怎么没出现」，不是
	 * 「有哪些技能」。不给这个标记的话，搜 `slides` 会顺带列出五个空目录，真命中反而被淹掉。
	 */
	auxiliary?: boolean;
	items: readonly ReportItem[];
}

/**
 * 报告正文的最小单位。
 *
 * `caption` 是一句灰字说明，`prose` / `code` 是原样保留的散文与代码块，`group` 是可折叠的条目组，
 * `empty` 是「这块没什么可看」的一句话（左右居中、上下各留一段空白，不贴着搜索行）。
 * 五种块按数组顺序渲染，折叠与搜索只作用于 `group`。
 */
export type ReportBlock =
	| { kind: 'caption'; text: RichText }
	| { kind: 'prose'; text: string }
	| { kind: 'code'; language?: string; text: string }
	| { kind: 'group'; group: ReportGroup }
	| { kind: 'empty'; text: RichText };

export interface ReportAction {
	/** 展示用的键名：`f`、`↑↓`、`esc`。 */
	key: string;
	/** 键名后面的说明：`filter`、`select`。 */
	label: string;
	/**
	 * 窄终端下的丢弃次序：数字越大越先丢。
	 *
	 * 提示放不下时省略号会从尾部盲切，最先吃掉的恰好是 `Esc`——关不掉的弹窗比没有提示更糟。
	 * 把"谁先让位"写成数据，就不必再维护一份手写的键名白名单。
	 */
	dropPriority: number;
}

export interface ReportTab {
	id: string;
	/** tab 栏文案。 */
	label: string;
	blocks: readonly ReportBlock[];
	/** 过滤后一条都没命中时的文案。 */
	empty: string;
	/** 本 tab 独有的动作；全局动作（选择、折叠、搜索、关闭）由弹窗自己补。 */
	actions?: readonly ReportAction[];
}

export interface ReportDoc {
	tabs: readonly ReportTab[];
	/** 打开时的落点 tab id；缺省用第一个。 */
	initialTab?: string;
}

/** 拍平成纯字符串。模糊匹配按文本比，不能按分段结构比。 */
export function plainText(text: RichText): string {
	if (typeof text === 'string') return text;
	if ('text' in text) return text.text;
	return text.map((segment) => segment.text).join('');
}

/**
 * 组标题的计数后缀，如 `(2 skills)`。没声明计量词时不渲染后缀。
 *
 * `hit` 与 `total` 不同时写成 `(命中/总数)`：sph 一贯报真实数字，不假装搜索结果就是全部。
 */
export function groupCountSuffix(group: ReportGroup, hit: number, total: number): string | null {
	if (group.countNoun === undefined) return null;
	const noun = total === 1 ? group.countNoun.replace(/s$/, '') : group.countNoun;
	return hit === total ? `(${hit} ${noun})` : `(${hit}/${total} ${noun})`;
}

/**
 * 一组块里的所有分组，按出现顺序。
 *
 * 只收 `blocks` 而不是整个 tab：检索后拿到的是筛过的块列表（已经不属于原 tab），
 * 折叠、计数、命中统计都只需要看块。
 */
export function reportGroups(blocks: readonly ReportBlock[]): ReportGroup[] {
	return blocks.flatMap((block) => (block.kind === 'group' ? [block.group] : []));
}
