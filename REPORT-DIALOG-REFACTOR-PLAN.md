# sph 报告类弹窗重构方案

> 目标项目：`spring-harness`（`sph`），改动集中在 `src/plugins/sph-tui` 与 `src/tui/widgets`。
> 参考实现：`grok-build-main`（Rust，`xai-grok-pager`）——仅作**版式与交互**参考，不搬代码结构。
> 状态：**方案待确认，尚未改动任何代码。**

---

## 一、现状分析

### 1.1 报告弹窗的完整链路

`/skills`、`/plugins`、`/help`、`/permissions`、`/mcps` 走的是同一条路：

```
slash 命令
  → interactive-mode.ts / *-commands.ts
  → renderXReport(...)          ← 纯函数：数据 → **markdown 字符串**
  → showMessageDialog(tui, {...commandPanelOptions(tui)})
  → MessageDialog
  → DialogShell + RoundedDialogBox      （dialogs.ts:485 / :97）
  → ScrollableTextBody extends DialogBody（dialogs.ts:233 / :198）
  → renderRoundedBox + Markdown 控件      （text/utils.ts:1364 / widgets/markdown.ts）
```

证据：`interactive-mode.ts:1585-1598`（/help）、`:1606-1616`（/plugins）、`:1624-1634`（/skills）、`settings-commands.ts:289-310`（/permissions）、`mcp-commands.ts:85-95`（/mcps）。

**这条链路的核心事实：报告在进入弹窗之前已经变成了一段纯文本。** 分组、优先级、计数、条目身份全都在字符串拼接时丢掉了，弹窗层拿到的是一个不可再解析的 `string`。

### 1.2 关键文件与规模

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/plugins/sph-tui/dialogs.ts` | 1011 | 全部弹窗：外壳、行预算、选择/输入/确认/长文本/加载 |
| `src/plugins/sph-tui/commands/reports.ts` | 530 | 5 份报告的 markdown 拼接（纯函数） |
| `src/plugins/sph-tui/interactive-mode.ts` | 2196 | 命令分发与调用点 |
| `src/tui/widgets/select-list.ts` | 493 | 选择列表（行渲染、滚动、悬浮、滚轮、点选、号槽） |
| `src/tui/text/utils.ts` | 1574 | `renderRoundedBox`(:1364)、`ruleHeadingLine`(:1421)、宽度与 ANSI 工具 |
| `tests/plugins/sph-tui/dialog-render.test.ts` | 894（24 用例） | 真实渲染链（`TuiAltScreen`）下的弹窗端到端断言 |
| `tests/plugins/sph-tui/commands/reports.test.ts` | 417（32 用例） | 报告文本的字符串断言 |
| `tests/plugins/sph-tui/dialogs.test.ts` | 108（11 用例） | 尺寸档位与浮层选项 |
| `tests/plugins/sph-tui/dialog-selection.test.ts` | 188（4 用例） | 浮层内拖选/复制 |

### 1.3 弹窗尺寸与行预算：四处必须"同源"的算术

这是 sph 弹窗现在最绕的地方，四处各算一遍、互相依赖：

1. `rowBudget(tui, maxHeight)`（`dialogs.ts:82`）——把 `maxHeight`（百分比或绝对值）换算成行数，并夹进 `rows - 2`。
2. `RoundedDialogBox.render`（`:132-168`）——用 `maxRows()` 再封顶一次，超限时**保留最后一行**（底边框）。
3. `DialogBody.render`（`:218-225`）——`maxBody = budget() - 2`，再上下各留一行空白。
4. `renderRoundedBox`（`text/utils.ts:1389-1400`）——底边框的提示/读数还要按列宽再算一次预算。

代码注释自己承认了这层耦合的代价：
- `:6-8`：「浮层只能整块渲染，超出的行由 overlay 从顶部裁掉——矮终端下会连圆角底边框和页脚一起消失。所以每个弹窗都按 showOverlay 的 maxHeight 领取行预算」；
- `:134-136`：「底边框、页脚和最后几条选项会一起消失……宁可挤掉中间的行，标题、页脚和底边框必须保住」；
- `:661`：「行预算与浮层选项必须用同一个值，否则互相打架」。

另外 `SelectBody`（`:427-451`）还要在"正文 + 分隔行 + 列表"三方之间再分行一次。

### 1.4 相邻能力盘点（决定复用什么）

| 能力 | 现状 | 位置 |
|---|---|---|
| 圆角框 + 顶边嵌标题 + 底边框提示/读数 | 已有，全套 | `renderRoundedBox`、`RoundedDialogBox` |
| 整行选中底色 / 悬浮底色 | **已有**（`rowSelectedBg #363636` / `rowHoverBg #2a2a2a`，行首挂底、行尾 `49m` 复位） | `select-list.ts:396-399`、`theme.ts:373-374` |
| 列表滚动 / 滚轮 / 点选 / 悬停 / 号槽 | 已有 | `select-list.ts:199-320` |
| 分组头 | 只有 `kind: 'header'`：装饰性 `─ 组名 ───`，**不可折叠、不可选中、无计数** | `select-list.ts:362-368` |
| 搜索 | **UI 完全没有**。`SelectList.setFilter` 是前缀匹配，只有编辑器补全菜单在用（`editor.ts:2419/2436`）；报告弹窗无处可用 | `select-list.ts:94-100` |
| 模糊匹配 | 已有 `fuzzyFilter`（打分、词边界加权） | `src/tui/input/fuzzy.ts`、`autocomplete.ts:415` |
| 单行文本 + 光标 | 已有 `Input`：反显光标 + `CURSOR_MARKER`（交给终端真光标） | `src/tui/input/input.ts:370-371, 426-429` |
| tab 栏 | **没有** | — |
| 键位注册表 | 已有 `APP_KEYBINDINGS`（`/help` 已从这里取数） | `input/app-keybindings.ts` |
| 鼠标命中区 | 已有 `MouseRegion` | `widgets/primitives.ts:693` |
| 间距/横线字形 | `─` 只有一种画法（`ruleHeadingLine` 注释明确要求全屏统一） | `text/utils.ts:1412-1444` |

---

### 1.5 三类弹窗机制（`/model` 这类属于第二类）

sph 现在有**三套并列**的弹窗渲染路径，各有独立的壳与键位提示：

| 机制 | 渲染者 | 挂在哪 | 可打字过滤 | 分组头可折叠 | 承载的命令 |
|---|---|---|---|---|---|
| **内联菜单**<br>`Editor.showInlineMenu`（`editor.ts:2371`） | `Editor` 自己在 `render` 里调 `renderRoundedBox`（`editor.ts:604-632`） | 输入框**上方**，与输入框共用编辑器的行预算（`maxEditorRows = rows - 3`，`:589-634`） | ✅ `filterable`，前缀匹配（`applyMenuFilter` `:2406`） | ❌ 只有装饰性 `kind:'header'` | `/resume`（`session-commands.ts:148`）、`/model`、`/provider`×3、`/effort`、`/permission`、`/notify`（`settings-commands.ts:92/133/197/250/265/335/374`）、命令面板（`interactive-mode.ts:1473`） |
| **浮层选择弹窗**<br>`showSelectDialog`（`dialogs.ts:747`） | `RoundedDialogBox` + `SelectBody` | 屏幕浮层（居中 / 顶部 10%） | ❌ **没有过滤能力** | ❌ 同上 | `/history`（`session-commands.ts:65`）、`/prompts`（`workspace-commands.ts:63`）、`/mcps`（`mcp-commands.ts:59/189`）、审批框（`interactive-mode.ts:1410`）、计划复核（`:1973`） |
| **浮层报告弹窗**<br>`showMessageDialog`（`dialogs.ts:972`） | `RoundedDialogBox` + `ScrollableTextBody` | 同上 | ❌ | ❌ | `/skills`、`/plugins`、`/permissions`、`/help`、MCP 报告 → **本次重构对象** |

（`showInputDialog` / `showLoadingDialog` / `showConfirmDialog` 是同一条浮层机制的不同正文，不算独立一类。）

**两条真实的不一致**：

1. **同族的 `/history` 与 `/resume` 分属两套机制，过滤能力相反**。两者都是"从长列表里挑一条"：`/resume` 走内联菜单，能打字过滤（`session-commands.ts:101` 的注释明确写了「选择器接受打字和粘贴：按会话 id 前缀过滤」）；`/history` 走浮层弹窗，`maxVisible: 14`，**列表长了只能 ↑↓ 翻**。这不是设计意图，是两条路径各自演化的结果。
2. **分组头在三套里都不可折叠**。`kind: 'header'`（`select-list.ts:362-368`）是装饰性 `─ 组名 ───`，不参与高亮、不计入 `(n/m)`。而 `/model` 恰恰是按 provider 分组的长列表（`settings-commands.ts:75`）、`/mcps` 是 Actions/Servers 两段（`mcp-commands.ts:66/70`）。

**本次的边界：三套的渲染路径仍不合并，但三套都要重构。** 三条注释分别写明了各自的定位，且都是有意为之：

- 内联菜单：「画在输入区上方，不走 /help 那种居中大弹窗」（`editor.ts:600`），语义是"这一步是**接着输入**做的，做完接着敲"；
- 浮层：「敲个命令就地展开的一层」（`dialogs.ts:698-705`）；
- 报告：语义是"**看**一份清单"，不在输入链条上。

**所以重构的做法是「一套共享控件 + 三个宿主」，不是「一个组件吃掉三种定位」**：

```
共享控件    SelectList（行/滚动/选中/悬浮 + 新增 group 折叠 + matcher 过滤）
            search-bar.ts（搜索行）   footer 派生（动作声明 → 提示文本）
            renderRoundedBox（corners 参数）   行预算算术（rowBudget / DialogBody）
   │
   ├─ 宿主 A：ReportDialog   —— 屏幕浮层，tab + 搜索 + 分组列表 + 框内 footer
   ├─ 宿主 B：SelectDialog   —— 屏幕浮层，标题 + 搜索 + 分组列表 + 框内 footer
   └─ 宿主 C：InlineMenu     —— 挂输入框上方，标题（查询并入标题）+ 分组列表 + 底边框提示
```

三个宿主各自保留**定位与行预算**（这是它们真正的差异，也是不能合并的部分），共享其余全部；键位提示、过滤语义、分组折叠、行渲染只有一份实现。二期补的两个缺口（`/history` 能搜、`/model` 分组可折叠）就是这个结构自然产出的结果，而不是额外的功能开发。

**一个必须先说清的耦合**：内联菜单的注释写明它「与补全菜单同一圆角边框盒」（`editor.ts:2366`），而且**两者走的是同一处渲染**（`editor.ts:604-632` 的 `activeMenu()` 同时返回补全菜单与内联菜单）。所以：

- 改**内联菜单**的框件 / 提示 / 分组 → 会**连带改掉 `/`、`@` 补全菜单**；
- 若要"只动参数选择器、不动补全菜单"，就得把这一处渲染拆成两条——那恰好是新增重复，与本次方向相反。

我的建议是**接受连带**（两套菜单本来就长得一样，一起改反而更一致），但这会让"敲 `/` 时弹出的菜单"也变成直角 + 新分组样式，**属于高频可见的改动**，需要你确认。

---

### 1.6 字形盘点（决定折叠字形时顺带做的）

sph **没有字形模块，也没有 ASCII 降级路径**——所有符号都是直接写在用处（`recap.ts:24` 的 `◆ ◇`、`tool-execution.ts:44` 的 `▸ ▾ ×`、`markdown.ts:1052` 的 `┌┬┐`）。`src/tui` + `src/plugins/sph-tui` 里的非文字符号共 30 余种，盘点结果：

| 符号 | 用处 | 位置 |
|---|---|---|
| `▸` / `▾` / `×` | **工具行的开合与失败**（`TOOL_MARK`） | `tools/tool-execution.ts:44-50` |
| `✲` | 思考行前缀（注释写明「不用 `▸`：斜体和箭头都会让思考行读成又一条工具」） | `tools/tool-group.ts:506` |
| `◆` / `◇` | recap 完成 / 生成中（`RECAP_MARK`） | `messages/recap.ts:24` |
| `●` | 终端 tab 标题的活动指示 | `interactive-mode.ts:347` |
| `↳` | notice 的子项 | `transcript/index.ts:396` |
| `│` | 工具详情块的左缘竖轨 | `tools/tool-execution.ts:67` |
| `─` | 全屏唯一的横线字形 | `text/utils.ts:1421`（`ruleHeadingLine`） |
| `┌┬┐├┼┤└┴┘` | **markdown 表格** | `widgets/markdown.ts:1052-1099` |
| `╭╮╰╯` | 弹窗与编辑器框 | `text/utils.ts:1364`（`renderRoundedBox`） |
| `↑↓ ←→ ⇧` | 键位提示 | `dialogs.ts:57-59`、`steer-bar.ts:293` |
| `█ ▄ ▀` | 进度条 / 分块 | `screen/layout.ts:514` |
| `⠋⠙⠹…` | 转轮 | `dialogs.ts:869` |
| `📁 🌿 🧩 🤖 🧠 🛡️ 🧮` | **footer 的常驻图标** | `footer/index.ts:59-79` |

**三条盘点结论**：

1. **`▸` / `▾` 已是事实上的开合语汇**（§六 第 8 行的依据），所以折叠字形应当复用它，而不是新造 `›` / `⌄`。
2. **`❙` 是死字形，但有一条过期注释在描述它**。选中标记早已移除——`tui-alt-screen.ts:896`「行首的 ❙ 选中标记已移除」、`selectable-row.ts:5`「实际使用里它总被读成行前缀的一部分」、`transcript-chrome.ts:17`「行选中标记(行首 ❙)已移除」；而 `widgets/select-list.ts:61` 的注释仍写着「选中条 `❙` 永远在最外，**与转录里工具行的选中条同列**」——实际渲染是 `selectedMark('>')`（`:379`），而且"转录里工具行的选中条"也已经不存在了。**这条注释在我们即将改的文件里，顺手修掉。**
3. **footer 的 7 个 emoji 是唯一有跨终端风险的符号**：sph 无降级机制，emoji 在部分终端会渲染成豆腐块或宽度不一致（`visibleWidth` 走 `get-east-asian-width`，与终端实际渲染宽度未必一致），而 footer 是常驻的。**不在本次范围**，但值得单独立项（`footer/index.ts` 已有 `droppable` 机制，可以配合做"宽度异常时降级成纯文字"）。

顺带一条**支持直角决定**的证据：`markdown.ts:1052-1099` 的表格已经在用 `┌┬┐└┘` 直角框线——所以"报告弹窗改直角"不是往全屏引入一套新语汇，而是与 markdown 表格对齐（真正只有一种画法的是 `─` 横线，直角框线本来就有）。

---

## 二、当前存在的问题

### P1 「报告」没有数据类型，只有字符串
`renderSkillsReport` / `renderPluginsReport` / `renderMcpReport` / `renderPermissionsReport` / `renderHelpReport` 的返回值都是 `string`（`reports.ts:81/148/333/419/475`）。分组、来源、优先级、计数这些**结构信息在拼字符串时就被抹平**，弹窗层再也拿不回来。于是：想加"按名字搜技能"，只能重新扫一遍数据、重新拼一份字符串；想折叠某个来源，做不到。

### P2 弹窗能力被"文本"锁死
`MessageDialog` 只能滚动。没有 tab、没有搜索、没有折叠、没有行选中、没有行内动作。要展示"六类清单"只能连续输出六段 `###`（对照截图里的六个 tab）。`/help` 已经是 60+ 行的长文，注释里承认过"要翻四屏"（`dialogs.ts:641`）。

### P3 为了让 markdown 不乱，被迫引入四个转义工具
`reports.ts` 里 `code()`(:29) / `plain()`(:44) / `secondary()`(:51) / `muted()`(:61) 四个函数存在的唯一理由是"把内容安全地塞进 markdown"：
- 内容里的反引号会提前闭合行内代码段（`:23-31`）；
- 换行会把一条列表项撑成多行（`:33-36`）；
- 同一份内容要两种语气就要两种包装。

`reports.test.ts` 里有 5 个用例专门守这个风险（`:95/:262/:362` 等）。**这些风险是"报告即 markdown"这个决定的直接产物**，不是业务需要。

### P4 目录与分页逻辑混在文案里
`renderSkillsReport`（:76-141）一个函数里同时干了：按 root 分组（:93-98）、按覆盖次序排序（:91-92/:99）、编号 `#1..#n`（:117）、路径缩成 `~`（:71-74）、生成组标题文案、生成空态、生成 warnings 段。这些是本该被测的**数据变换**，现在只能通过断言输出字符串的子串来间接验证。

### P5 分组头不可折叠、不可选中、不带计数
`SelectItem.kind: 'header'` 只是装饰线（`select-list.ts:362-368`），不参与高亮、不参与确认、不计入 `(n/m)`。截图中"组头带计数 + 折叠箭头 + 整行可选中"这一整套在 sph 里完全没有。

### P6 footer 提示是两处失联的手写清单
- 提示文本由各 `DialogBody.footerText()` 手写（`dialogs.ts:283-288`、`:413-417`、`:474-477`、`:900-903`）；
- 紧凑档的键名白名单 `HINT_KEYS`（`:64`）是**手工维护**的一份清单，新增键位（如报告的 `f` 过滤、`r` 重载）不会自动进紧凑档；
- `/help` 里列出的键位来自 `APP_KEYBINDINGS` 注册表，而弹窗底部的提示来自 `HINT_KEYS`——**同一件事两个来源**，注释里"Esc 永远保留"的意图（`:66-71`）也只写在了代码里。

### P7 `commandPanelOptions` 的五行样板被抄了三遍
`interactive-mode.ts:1593-1596`、`:1611-1614`、`:1629-1632` 三处一字不差：`{ hint: 'Esc close', termColumns: true, ...commandPanelOptions(this.ui) }`。`/permissions`（`settings-commands.ts:307-310`）是第四处。新增一份报告就要再抄一次。

### P8 短内容被撑成固定窗口的取舍只能在"高度"上找平衡
`dialogs.ts:219` 注释：「预算是上限不是目标高度。短内容按行数收，避免 `/help` 这类弹窗被撑成一块固定窗口」。截图里弹窗是"高框 + 内容顶部对齐 + 下方留白"——与这里"按行数收"的取向**相反**。这个取舍现在没有参数可表达。

### P9 报告弹窗与选择弹窗共用一套壳，但需求已经分叉
`showSelectDialog` 要的是"选一个并确认"（窄、居中、焦点在选项）；报告要的是"看清单并可导航"（宽、高、搜索、折叠）。两者现在共用 `DIALOG_LAYOUTS` 与 `DialogBody`，`SelectBody`（`:310-458`）里为了同时服务"正文 + 列表"引入了 `LIST_RESERVE_ROWS`、`renderScrollInfoLine=false`、`listTop/listRows` 坐标换算等一堆折中。

---

## 三、重构目标

1. **给"报告"一个数据类型**：`ReportDoc`（tab → 分组 → 条目）成为报告的产出，markdown 字符串退出报告链路。
2. **补齐报告弹窗的交互**：tab 栏、搜索、折叠、整行选中、footer 快捷键行——对齐截图。
3. **删掉转义工具**：`code` / `plain` / `secondary` / `muted` 与它们背后的 markdown 转义风险一起消失。
4. **提示单一来源**：`HINT_KEYS` 手写白名单删除，footer 提示由 action 声明派生，`/help` 的键位清单与弹窗提示同源。
5. **收敛样板**：`showReportDialog(tui, doc)` 一个入口，调用方不再抄五行；五个命令各降为一行。
6. **不破坏现有观感与取舍**：`confirm` / `input` / `loading` / 审批框 / `/resume`、`/history` 等选择型弹窗保持原样。
7. **定位与尺寸对齐截图**：报告弹窗垂直居中 + 盒子吃满 `rowBudget`（内容顶部对齐、其余留白）；宽高上限继续随终端尺寸每帧自适应。详见 §4.8。
8. **报告面板只有一个组件**：5 个 tab 是数据（`ReportTab`），不是 5 份渲染代码；4 条命令只决定落点，新增报告不改弹窗代码。数据源按需 build。详见 §4.3 末尾。
9. **三套弹窗共享控件层，但保留各自的定位**（§1.5）：`SelectList` / `search-bar` / footer 派生 / 框件 / 行预算算术收敛成一份，三个宿主（报告、浮层选择、内联菜单）各自只保留定位与行预算。连带产出：`/history` 能搜、`/model` 的分组可折叠、内联菜单默认开启过滤。
10. **报告弹窗边框改直角**（`renderRoundedBox` 加 `corners` 参数，默认仍 `round`），其余框件观感不动。

---

## 四、整体设计思路

### 4.1 分层

```
数据（业务侧）            ReportDoc（纯数据）
skills / plugins /  ──►    tabs: ReportTab[]
mcps / permissions         └ blocks: ReportBlock[]        ← caption | group | prose | code
/ keybindings 注册表           └ group.items: ReportItem[]
                                     │
                                     ▼
交互层（sph-tui/report）  ReportDialog
                           ├ 折叠状态   Map<tabId, Set<groupKey>>
                           ├ 搜索查询   Input（复用）
                           ├ 筛选档     ReportTab.filter
                           └ footer     ReportTab.actions → ShortcutHint[]
                                     │
                                     ▼
控件层（src/tui/widgets）  RoundedDialogBox + TabBar + SearchBar + SelectList(扩展)
```

**分层边界**：`src/tui` 只收通用控件（tab 栏、搜索行、分组行渲染），不引用会话/工具/权限/命令注册表（沿用 `src/tui/index.ts:1-13` 的既有约束）；报告语义、数据源、命令注册表都留在 `src/plugins/sph-tui/report`。

### 4.2 数据模型

```ts
/** 一次打开的完整报告：一到多个 tab。 */
export interface ReportDoc {
  /** 边框标题。单 tab 时嵌在顶边（沿用 sph 现有观感）；多 tab 时让位给 tab 行。 */
  title: string;
  tabs: readonly ReportTab[];
  /** 打开时落点（`/plugins` → 'plugins'）。 */
  initialTab?: string;
}

export interface ReportTab {
  id: string;
  label: string;
  /** 搜索占位文案，缺省 `/ to search`。 */
  searchPlaceholder?: string;
  /**
   * 筛选档（截图右侧那格 `All f`）。
   *
   * **一期没有任何 tab 声明它**——sph 的数据里不存在真实的筛选档：被禁用的插件/服务器
   * 直接不在列表里，技能的来源已经是分组，命令的分组已经是 `group`。grok 那格能用，
   * 是因为它的插件模型有 enabled/disabled 两态。
   *
   * 所以一期**不画这一格**（搜索行右侧留空），保留字段等真实的筛选需求出现——
   * 最容易想到的一个是 `/skills` 的 `All / Winner`（同名技能被多个根广告时只看胜出者，
   * 现在只在报告末尾用一句 caption 交代）。
   */
  filter?: { key: string; levels: readonly string[]; initial: number; matches(item: ReportItem, level: number): boolean };
  blocks: readonly ReportBlock[];
  /** 过滤后无命中时的文案。 */
  empty: string;
  /** 底部快捷键。footer 只负责画，不负责编。 */
  actions: readonly ReportAction[];
}

/**
 * 报告正文的最小单位。
 *
 * 引入 `prose` / `code` 是为了**不改动那几段本来就该是散文的内容**——MCP 空态里
 * 那段可抄的 toml 配置、`/permissions` 的求值说明、`/help` 尾部的队列与编辑器说明，
 * 强行拆成条目只会把原本读得通的一段话切碎。
 */
export type ReportBlock =
  | { kind: 'caption'; text: string }        // 一句灰字说明（现在的 muted(...)）
  | { kind: 'group'; group: ReportGroup }
  | { kind: 'prose'; text: string }          // 段落，走 Markdown 渲染
  | { kind: 'code'; language?: string; text: string };

export interface ReportGroup {
  /** 折叠状态的身份，也是"这一组是什么"的稳定名字。 */
  key: string;
  /** 组标题正文，如 `User — ~/.sph/skills`。 */
  label: string;
  /** 计数后缀：渲染成 `label (n noun)`。`n` 由过滤结果给出。 */
  countNoun?: string;
  collapsible?: boolean;
  initiallyExpanded?: boolean;
  items: readonly ReportItem[];
}

export interface ReportItem {
  /** 稳定身份（技能名 / 插件名 / 命令 id / 键位文本）。搜索、选中、测试都按它。 */
  key: string;
  /** 主列。编号这类"顺序"信息是数据的一部分，就写在这里（见 §4.3 末尾）。 */
  label: RichText;
  description?: RichText;
  /** 右对齐尾列：来源、别名。 */
  trailing?: RichText;
  tone?: 'danger' | 'warning';
  /** 灰色注脚（现在 `muted(...)` 的路径），折叠时不显示。 */
  notes?: readonly RichText[];
}

/**
 * 行内富文本：**分段 + 语气**，不是 markdown。
 *
 * 现在报告里 `tools: \`mcp\` · services: \`mcp\`` 这种「整句里少数几个词是行内码蓝」的
 * 排版，靠 `code()` 往字符串里塞反引号实现——而那正是 `reports.ts` 那四个转义工具
 * 存在的理由。改成结构化分段之后：**强调由类型表达，不用转义，也不用再解析 markdown**。
 *
 * 四种语气对应现有主题的四个档次：code = 行内码蓝、muted = 灰、warn = 橙、error = 红。
 */
export type RichText = string | readonly TextSegment[];
export interface TextSegment {
  text: string;
  tone?: 'code' | 'muted' | 'warn' | 'error';
  bold?: boolean;
}

export interface ReportAction {
  /** 展示用的键名："f" / "space" / "esc"。 */
  key: string;
  label: string;
  /** 缺省只展示不可触发。 */
  run?: () => void | Promise<void>;
  /**
   * 窄终端下丢弃次序：数字越大越先丢。`Esc` 声明成最高，把现在
   * compactHint 里「Esc 永远在场」那句注释变成数据。
   */
  dropPriority: number;
}
```

### 4.3 五个报告 → tab 划分

| tab id | label | 来源 | 现在的渲染函数 |
|---|---|---|---|
| `skills` | Skills | `scanSkills(...)` | `renderSkillsReport` |
| `plugins` | Plugins | `deps.pluginReport()` | `renderPluginsReport` |
| `mcp` | MCP | `McpService` | `renderMcpReport`（**二期**，见 R7） |
| `permissions` | Permissions | `compileLayers` 等 | `renderPermissionsReport` |
| `commands` | Commands | `COMMANDS` + `COMMAND_ALIASES` | `renderHelpReport` 前半 |
| `keys` | Keys | `APP_KEYBINDINGS` | `renderHelpReport` 后半 |

关键点：**每个既有命令都保留，只是落点不同**——`/skills` 打开面板并停在 `skills` tab（与 grok 的 `/hooks` → Hooks tab 是同一个模型）。`/help` 打开面板停在 `commands` tab。

`/help` 拆成两个 tab 正好让面板在第一天就是"真的多 tab"，而不是为将来预留的空壳。

四个 tab 的 `actions` 各不相同，这也顺带验证了 footer 必须由 tab 声明（§4.6）：Skills / Plugins / Permissions / Commands / Keys 在一期**都没有额外动作**，footer 只有全局的四项（`↑↓ select · ←→ fold · Tab tab · / search · Esc close`）。`r reload` 之类要等真的需要时才声明。

**两条从手绘稿里发现、必须写进实现的约束**：

1. **Permissions 的规则编号必须进 `label`，不能进 `SelectList` 的 `numbered` 号槽**。号槽（`select-list.ts:347-360`）算的是"可选行里的第几条"，搜索过滤后编号会跟着变——而这份报告的编号是**求值顺序**，正文里还用 `#3 ignored` 这样的句子引用它（`reports.ts:432-441`）。过滤一次编号就漂，等于给了个假信息。
2. **`Enter` 在条目上不做事**。`dialog-render.test.ts:728` 那条断言（`/help 是报告框……且不再有可点选的列表`）的前提会被推翻，但推翻的方向是"报告变成可导航列表"，**不是**"报告变成可执行菜单"——sph 的取向是把"看清单"和"执行"拆开（`interactive-mode.ts:1582-1583`）。要不要给 Commands tab 加 `Enter insert`（把命令插回输入框）是一个**独立增量**，不在本次范围内。

#### 只有一个弹窗

**要实现的组件是一个，不是五个。** 整个链路是：

```
4 条命令 ──┐
           ├─► openReport(ui, tabId) ──► ReportDialog（唯一组件）
Tab 键 ────┘                                  └─ tabs: ReportTab[5]  ← 数据，不是渲染代码
```

- 5 个 tab 各是一份 `ReportTab` 数据（label + blocks + actions），由 `report/registry.ts` 汇总；
- 命令只决定 `initialTab`，**五个 tab 共用同一套 tab 栏 / 搜索 / 分组列表 / footer / 键鼠路由**；
- 因此新增一类报告 = 加一个 `ReportTab` 声明 + 注册表一行，**不动弹窗代码**。这也是本次重构最大的收益：现在加一份报告要抄一遍 `renderXReport` + 一遍 `showMessageDialog` 的五行样板（P7）。

**随之而来的一个真实设计点：tab 必须懒构造 + 单次打开内缓存。**

5 个数据源的成本差别很大——`scanSkills()` 要读 4 个根的 `SKILL.md` 文件头（`interactive-mode.ts:1625` 注释：「当场扫就能立刻看到；代价只是读几个 SKILL.md 的文件头」）、`deps.pluginReport()` 走插件宿主、`compileLayers()` 要读权限配置文件。现在每条命令各自在打开时取一次数据，互不干扰；合成一个弹窗之后，**如果打开时把 5 个 tab 全 build 一遍，等于每次 `/skills` 都顺带做完全部 IO**。

规则：

- `openReport` 只 build `initialTab`；`Tab` 切到哪个才 build 哪个；
- 缓存**只在本次打开内有效**（键 = `tabId`），关闭即丢——数据必须反映"打开这一刻的真实状态"，这与 `commandPlugins` 那条注释的取向一致（`:1602-1604`：「状态必须来自当下这份报告而不是快照」）；
- 构建失败的 tab 显示空态而不是把整个弹窗拖垮（`TabDataState` 那套 Error 分支的思路，现在散在各命令里）。

**`Keys` 没有直达命令**：`/help` 落在 Commands，Keys 靠 `Tab` 到达。要直达就加一个 `/keys`，成本是注册表里一行加一个命令文件——**要不要加由你定**（我倾向不加，4 条命令覆盖 5 个 tab 已经够，多一条命令就多一份要维护的补全列表文案）。

### 4.4 搜索

- 复用 `src/tui/input/fuzzy.js` 的 `fuzzyFilter`，匹配字段 `label + description + notes + group.label`——`RichText` 要先经一个 `plainText()` 拍平成纯字符串（**不解析 markdown**，只拼接 `TextSegment.text`），否则分段结构会把模糊匹配打散。
- **空查询不重排**：分组与组内顺序是业务算出来的优先级（`renderSkillsReport:91-92` 的覆盖次序），模糊分没有资格覆盖它。
- 有查询时：丢掉零命中的组；命中题的 `count` 写成 `命中/总数`（`User (2/5 skills)`）。sph 的一贯取向是"报真实数字"（`renderSkillsReport:117` 的 `· N`、`:125` 的编号都是这个意思），不假装搜索结果就是全部。
- **搜索时强制全展开**：命中的条目如果藏在折叠组里，搜索等于没做。展开只看不改——清空查询后回到用户原来的折叠状态。

### 4.5 折叠

- 状态：`Map<tabId, Set<groupKey>>` 存"被折叠的组"，**按 tab 分开**，弹窗关闭即丢，不落配置。
- 默认全展开（与现在一致），`initiallyExpanded: false` 的组例外。
- 交互：`←/→` 折叠/展开当前组；`Enter` 在组头上是折叠/展开（不是"确认"）；组头的 `(n/m)` 计入导航序次（`SelectList.selectableOrdinal` 已经只数可选行，组头若可选中需要一并算）。

### 4.6 footer 与提示单一来源

- footer 由 **tab 声明 + 全局项** 合成：全局 `↑↓ select`、`Tab tab`（多 tab 时）、`/ search`、`Esc close`；tab 自己声明 `f filter`、`r reload`、`space enable/disable`。
- 渲染：框内**居中一行**，键加粗、说明 `muted`、` · ` 分隔（沿用 sph 的分隔符，见 §六 偏差说明）。
- 窄终端：按 `dropPriority` 从大到小丢项，`Esc` 的优先级最低（最后丢）。`HINT_KEYS`(:64) 与 `compactHint`(:72) 删除。

### 4.7 行预算的收敛（P3/P8）

新增的 tab 行 + 搜索行 + 分隔线 + footer 行是**固定开销**，必须与 `rowBudget` 走同一份算术。做法：

- 在 `report/body.ts` 里把这 4 行算成 `ReportChrome = { tabRows, searchRows, dividerRows, footerRows }`；
- `ReportBody.minContentRows` 返回 `1`，`renderContent(width, rows)` 里 `rows` 已经扣掉 chrome；
- **不新增第五处算术**：`RoundedDialogBox` 的 `maxRows` 仍然吃 `rowBudget` 的结果，`ReportBody` 只在它内部减一次 chrome。
- 短内容是否撑满（P8）：给 `showReportDialog` 一个 `fill: boolean`，报告默认 `true`（对齐截图的"高框 + 下方留白"），其余弹窗保持"按行数收"。

### 4.8 定位与尺寸（居中 / 自适应）

#### 现状事实

| 维度 | 现状 | 证据 |
|---|---|---|
| 水平 | **居中** | `anchor: 'center'`（未给 `col`）→ `col = marginLeft + floor((availWidth - width)/2)`，`tui.ts:1362-1377` |
| 垂直 | **不居中**：盒顶固定在屏高 10% | `commandPanelOptions` 给 `row = Math.floor(rows * 0.1)`（绝对行号，`dialogs.ts:720`）；`resolveOverlayLayout` 里 `opt.row !== undefined` 分支**优先于 anchor**（`tui.ts:1290-1310`） |
| 盒子高度 | **贴合内容**，`maxHeight` 只是上限 | `compositeOverlays`：先 `component.render(width)`，只在超限时 `slice(0, maxHeight)`，再用**实际行数**算 `row/col`（`tui.ts:1413-1421`）。`DialogBody:219` 注释：「预算是上限不是目标高度。短内容按行数收」 |
| 终端尺寸自适应 | **✅ 每帧重算** | `resolveOverlayWidth`/`resolveOverlayLayout` 用当帧 `termWidth/termHeight`；`rowBudget` 是懒求值闭包 `() => rowBudget(tui, maxHeight)`，resize 立即生效 |

**顺带查出的一个死配置**：`overlayOptions` 无条件返回 `anchor: 'center'`（`dialogs.ts:689`），但 `commandPanelOptions` 又永远带上 `row`，而 `row` 优先级更高 → **`anchor` 实际从未生效**。这与它上方那句注释骂过的 `width`（`dialogs.ts:685`「签名里有、没往下传，调用方传了也不生效」）是同一类问题，只是这次是"传了、被覆盖"。

#### 与截图的差距

以 `rows = 40`、内容 20 行、终端 147 列为例：

| 维度 | 截图 | sph 现状 | 差距 |
|---|---|---|---|
| 水平居中 | ✅ | ✅ | 无 |
| 垂直 | 居中 | 盒顶固定 10% → `row = 4` | 居中应为 `row = 10`（`1 + floor((38-20)/2)`），**差 6 行，肉眼明显贴顶** |
| 盒子高度 | 固定高框（约屏高 73%）+ 内容顶部对齐 + 下方留白 | 盒高 = 内容 + 2 = 22 行 | 目标 30 行（`rowBudget('75%')`），**差 8 行** |
| 宽/高上限自适应 | ✅ | ✅ 宽 `60%` 封顶 `120`，高 `75%` | 无 |

注意：两者是**耦合**的。若盒子吃满 30 行预算，则 `row = 4`（现状）与 `row = 5`（居中）**只差 1 行**，看不出区别；差距只在"内容少、盒子缩水"时暴露。所以真正要改的是**盒子高度**，居中是为了在内容少时也不塌到顶部。

#### 重构后的策略

1. **垂直居中**：`showReportDialog` 的浮层选项**不传 `row`**，只留 `anchor: 'center'` → `row = marginTop + floor((availHeight - height)/2)`。
2. **盒子吃满预算**（`fill: true`）：`ReportBody.render` 输出**满 `budget()` 行**——内容从顶部排、其余留空，于是盒高 = `rowBudget`，与截图一致。
3. **上下限不变**：宽 `60%` + `maxWidth 120`（窄终端百分比胜出、宽终端封顶，`resolveOverlayWidth` 已有测试覆盖）；高 `maxHeight = rowBudget(tui, '75%')`，与浮层选项同源（§1.3 的既有约束）。
4. **清掉死配置**：`commandPanelOptions` / `overlayOptions` 不再同时产出 `row` 与 `anchor`——二者只留其一，并在类型上把"同时给"表达成不可能，避免下一个人再踩。
5. **影响边界**：**只改报告弹窗**。`/resume`、`/history`、`/docs` 等仍走 `commandPanelOptions` 的顶部锚定——它们的定位意图是"敲个命令就地展开的一层"（`dialogs.ts:698-705` 的注释写明了），改成屏幕居中属于另一个设计决定，本次不动。

**需要你拍板的一点**：sph 现在这套定位是**有意**做成"就地展开、贴着顶部"的（注释原文：「都是『敲个命令就地展开的一层』，不该一个宽一个窄、来回换底色」）。截图是屏幕居中的模态。上面第 1、2 条等于**改掉这个设计意图**——如果你认为 sph 该保持"就地展开"，那就只做第 2 条（盒子吃满预算），第 1 条不改，此时短内容会贴顶但那正是原设计。请二选一。

---

## 五、需要改动 / 新增的文件与模块

### 5.1 新增

| 文件 | 职责 |
|---|---|
| `src/tui/widgets/tab-bar.ts` | 通用 tab 栏：绘制（选中加粗主色 / 未选中 muted）、`next/prev` 环回、命中区（`Rect[]`）供鼠标 |
| `src/tui/widgets/search-bar.ts` | 通用搜索行：左文案（占位 `/ to search` 或 `/ {query}`）、光标（复用 `Input`）、右侧标记槽（预留给筛选档，**一期无 tab 使用**）、命中区 |
| `src/plugins/sph-tui/report/doc.ts` | `ReportDoc` / `ReportTab` / `ReportBlock` / `ReportGroup` / `ReportItem` / `ReportAction` 类型 + 纯工具（`visibleItems`、`counts`、`flatten`） |
| `src/plugins/sph-tui/report/search.ts` | 查询 → 过滤后的 `ReportTab`（fuzzy 匹配 + 命中计数 + 强制展开）；纯函数 |
| `src/plugins/sph-tui/report/fold.ts` | 折叠状态（`Map<tabId, Set<groupKey>>`）+ 展开/折叠/全展开 |
| `src/plugins/sph-tui/report/body.ts` | `ReportBody extends DialogBody`：chrome 行数分配、块渲染（caption/prose/code 走 Markdown，group 走列表）、鼠标坐标换算 |
| `src/plugins/sph-tui/report/dialog.ts` | `showReportDialog(tui, doc, options)`：组装外壳 + tab + 搜索 + 列表 + footer，键盘路由，鼠标路由，`settleOnce` 收尾 |
| `src/plugins/sph-tui/report/registry.ts` | tab 注册表：`tabId → { label, build(ctx): ReportTab }`；`openReport(ui, tabId)` 一行入口。**`build` 按需调用**（只 build 打开时的落点 tab，切过去才 build 下一个，见 §4.3 末尾） |
| `src/plugins/sph-tui/report/sources/skills.ts` | `skillsTab(ctx): ReportTab`（分组 / 覆盖次序 / 编号 / 路径缩写 / 空态 / warnings） |
| `src/plugins/sph-tui/report/sources/plugins.ts` | `pluginsTab(ctx)` |
| `src/plugins/sph-tui/report/sources/permissions.ts` | `permissionsTab(ctx)` |
| `src/plugins/sph-tui/report/sources/help.ts` | `commandsTab(ctx)` + `keysTab(ctx)` |
| `src/plugins/sph-tui/report/sources/mcps.ts` | `mcpTab(ctx)`（二期） |

### 5.2 改动

| 文件 | 改动 |
|---|---|
| `src/tui/widgets/select-list.ts` | 扩展三处：① `SelectItem.kind` 增 `'group'`（可折叠分组头：折叠箭头 + 计数后缀 + 可选中 + 整行底色），折叠字形常量 `FOLD = { collapsed: '›', expanded: '⌄' }` 也放这里，三套宿主共用；② 搜索匹配从写死的 `startsWith` 改为可注入 `matcher`（`setFilter` 保持现状兼容编辑器补全）；③ 暴露 `expandedKeys` 由宿主传入（列表只负责画，折叠状态不归它管）。**不改动 `'header'` 的现有语义**。<br>**注意这是三套机制（报告 / 浮层选择 / 内联菜单）的共用件**——一期只用前一套，但扩展必须向后兼容，见 R13 与 §1.5。 |
| `src/plugins/sph-tui/dialogs.ts` | 导出 `RoundedDialogBox` / `DialogBody` / `rowBudget` / `PAD_X` 供 report 层复用；删除 `HINT_KEYS`(:64) 与 `compactHint`(:72)（紧凑档改由 `ReportAction.dropPriority` 驱动）；`compactHint` 的调用点（`:287/:416/:476/:902`）改为新机制或内联常量；`showMessageDialog` 保留（prose/diff/审批预览仍在用）。 |
| `src/plugins/sph-tui/commands/reports.ts` | 退化为 `report/sources/*`：删除 `code`/`plain`/`secondary`/`muted`/`oneLine` 与全部 `lines.push()` 拼接；导出签名从 `(): string` 改为 `(): ReportTab`。文件从 530 行降到约 300 行（纯数据映射）。 |
| `src/plugins/sph-tui/interactive-mode.ts` | `commandHelp`(:1585) / `commandPlugins`(:1606) / `commandSkills`(:1624) 各降为 `await openReport(this.ui, '<tabId>')`；`commandItems()` 保留（注册表取数不变）。 |
| `src/plugins/sph-tui/commands/settings-commands.ts` | `commandPermissions`(:289-310) 同样降为 `openReport(this.ui, 'permissions')`。 |
| `src/plugins/sph-tui/commands/mcp-commands.ts` | 二期：`:85-95` 的 `showMessageDialog(renderMcpReport(...))` 换成 `mcpTab`；`:59/:189` 的 `showSelectDialog` 动作菜单改走宿主 B（搜索 + 分组），"查看"与"管理"继续分开。 |
| `src/tui/text/utils.ts` | `renderRoundedBox` 加 `corners?: 'round' \| 'square'`（**默认 `round`**，纯增量）；报告弹窗与（待确认的）另两个宿主显式传 `square`。 |
| `src/plugins/sph-tui/dialogs.ts`（宿主 B） | `showSelectDialog` 加 `searchable` + 分组：`SelectBody` 需要一条**字符输入通路**（现在只转发导航键，R14）。默认给列表型弹窗开启搜索，标题保留在顶边框。 |
| `src/tui/input/editor.ts`（宿主 C） | `showInlineMenu` **默认 `filterable: true`**（现在只有 `/resume` 显式传，`/model` 明明可能几十行却不能搜）；过滤从前缀匹配改走共用 `matcher`（fuzzy）；`editor.ts:619-621` 两串硬编码提示改为共用派生。<br>**注意**：这一处同时服务补全菜单（`activeMenu()`），改动会连带 `/`、`@` 补全菜单——见 §1.5 末尾的耦合说明。 |

### 5.3 明确不动

- **三套弹窗的定位语义不合并**（§1.5）：内联菜单挂输入框上方、浮层居中/贴顶，这是它们真正的差异，三个宿主各自保留自己的定位与行预算；
- `src/plugins/sph-tui/trust/*`（信任页，走深路径、不经 `sph-tui` 全局栈）；
- `showConfirmDialog` / `showInputDialog` / `showLoadingDialog` 的**正文形态**（不是列表型；但可以共用 `corners` 与 footer 派生）；
- `Markdown` 控件（`prose` / `code` 块继续用它）。

### 5.4 测试

| 项 | 内容 |
|---|---|
| 新增 `tests/plugins/sph-tui/report/doc.test.ts` | 数据断言：分组划分、覆盖次序、编号、命中计数、空态（替代现在对字符串子串的断言） |
| 新增 `tests/plugins/sph-tui/report/search.test.ts` | fuzzy 命中、空查询不重排、命中计数、搜索强制展开 |
| 新增 `tests/plugins/sph-tui/report/render.test.ts` | 真实渲染链（复用 `dialog-render.test.ts` 的 `FakeTerminal` + `TuiAltScreen`）断言：tab 行、搜索行、分隔线、分组头计数、选中行底色、footer 居中 |
| 迁移 `tests/plugins/sph-tui/commands/reports.test.ts` | 32 个用例中约 26 个（分组/排序/编号/空态/来源）改为数据断言；`Warnings` 段与 `###` 文案类断言随之作废 |
| 迁移 `tests/plugins/sph-tui/dialog-render.test.ts` | `/skills`(:650)、`/plugins`(:684)、`/help`(:728)、`/permissions`(:758) 四个端到端用例改断言新结构；`/help 不再有可点选的列表`(:728) 这条**断言的前提被推翻，需重写** |
| 保留 | `dialogs.test.ts`(11)、`dialog-selection.test.ts`(4)、`tests/tui/widgets/select-list.test.ts`(243 行)、审批框相关用例 |
| 新增（二期 S6） | `/history` 获得过滤后的行为断言；`/model` provider 分组折叠；`tests/tui/input/editor-focus.test.ts` / `editor-input.test.ts` 全绿作为内联菜单未被破坏的前置条件 |

---

## 六、与截图目标效果的对应关系

| # | 截图元素 | grok 参考实现 | sph 现状 | 重构后 |
|---|---|---|---|---|
| 1 | 细边框 + 右上 `[✕]` | `render_modal_window` + `render_close_button`（`modal_window.rs:406`） | `renderRoundedBox` 圆角框 + 顶边嵌标题，**无关闭钮**（靠 Esc） | **不加**。保留圆角框与「Esc 是唯一关闭语义」的现状——多一个关闭钮就多一条鼠标命中区与坐标换算（`RoundedDialogBox.handleMouse` 的换算本来就是 bug 高发区，见 R3），而 `Esc close` 已常驻 footer（§4.6）。多 tab 时顶边不嵌标题，单 tab 时仍保留 `╭─ Skills ─╮` |
| 2 | Tab 栏：选中白色加粗、其余灰、无括号 | `render_tab_bar`（`modal_window.rs:441`） | 无 | 新增 `tab-bar.ts`；选中 = `theme.bold(theme.fg('primary'))`（sph 主色紫，对应 grok 的白），未选中 = `fg('muted')` |
| 3 | `/ to search` 占位（暗灰） | `picker.rs:507-517`（`gray_dim`） | 无搜索 UI | 新增 `search-bar.ts`；占位用 `fg('dim')`；光标复用 `Input`（自带终端真光标） |
| 4 | 右侧 `All f` 筛选标记 | `render_filter_indicator`（`picker.rs:700`） | 无 | **一期不画这一格**。sph 的数据里没有真实的筛选档（禁用项直接不在列表里），照搬会得到一个按了没反应的装饰。搜索行右侧留空，`ReportTab.filter` 字段保留待真实需求（§4.2） |
| 5 | 搜索行下整宽 `─` | `picker::render_divider` | 无（字形已有） | 复用 `─` 字形画纯线，`borderMuted` 着色 |
| 6 | 组头 `User (5 skills)` 整行底色 | `PickerRow{selected}` → `theme.bg_visual` | 只有装饰性 `header`；**但整行底色机制已有**（`selectedBg` = `rowSelectedBg #363636`） | `kind:'group'` 可选中；底色**直接复用现有机制**（这一条 sph 已经比 grok 完整） |
| 7 | 计数后缀 `(5 skills)` | Skills `extensions_modal.rs:2872` | `### #1 User — … · 2`（计数混在标题文案里） | `ReportGroup.countNoun` + 过滤结果计数，渲染成 `label (n noun)` |
| 8 | 子项缩进 + `›` / `◆` 折叠箭头 | `render_fold_indicator` + `glyphs::chevron()` | 无（`◆` 字形在 `messages/recap.ts:24` 出现过） | 分组头两态：**折叠 `▸` / 展开 `▾`**——复用 sph 已有的开合语汇，不用 grok 的 `◆` 也不新造 `›`/`⌄`（见 §1.6） |

**折叠字形：定 `▸`（折叠）/ `▾`（展开）。**

第一轮我提的 `›`/`⌄` 是**错的**——盘点字形时发现 sph 早就有自己的开合语汇，就在转录区的工具组上：

```ts
// tool-execution.ts:44-50
export const TOOL_MARK = {
  running: '▸', done: '▸', settled: '▸',
  expanded: '▾',
  fail: '×',
} as const;
```

`tool-group.ts:479` 的注释写明：「箭头表达组开合（`▸`/`▾`）」。也就是说**同一个屏幕上，转录里的工具组已经在用 `▸▾` 表示开合**；报告弹窗再用一套 `›⌄`，就又多了一种同义异形的表达——正是本次要消除的那类不一致。

不用 `◆` 的理由（你的要求）依然成立，且现在有了更硬的两条：

- **语义冲突**：`◆` 在 `messages/recap.ts:24` 的 `RECAP_MARK = { done: '◆', pending: '◇' }` 里表示"已完成"，同屏两义；
- **不成对**：`◆` 是实心块，与任何细箭头配对都会在折叠/展开时"换了控件"。

`▸`/`▾` 一次解决两条：同族（都是实心小三角，重量一致）、且**复用现成语汇**。附带的好处是 `▾` 出自 Geometric Shapes，占满一格，没有 U+2304 那种"模糊宽度"风险。
| 9 | 内容顶部对齐 + 下方大面积留白 | picker 溢出才滚 | `DialogBody` 是"按需收高"（`:219`） | `showReportDialog` 默认 `fill: true`：高框 + 顶部对齐 + 留白（对齐截图） |
| 10 | 居中 footer：键加粗、说明灰 | `render_modal_shortcuts`（`modal_window.rs:627`，居中 + 键 BOLD） | 提示嵌在**底边框左侧**，读数在右侧 | 报告弹窗改为**框内居中 footer 行**；`confirm`/`input`/`loading` 保持底边框写法 |
| 11 | 弹窗垂直居中 | overlay 居中（`modal_window.rs` 的 `compute_modal_dims` + 居中定位） | **水平居中 ✅，垂直不居中**：盒顶固定在屏高 10%（`commandPanelOptions` 的 `row`，覆盖了 `anchor`），内容少时明显贴顶（`rows=40` 时差 6 行） | `showReportDialog` 不传 `row`，走 `anchor: 'center'`（§4.8）。**同时清掉 `overlayOptions` 里那个被 `row` 覆盖的 `anchor` 死配置** |
| 12 | 宽高随终端自适应 | 尺寸按终端算 | **已有**：宽 `60%` 封顶 `120`、高 `75%` 上限，且每帧重算（`resolveOverlayWidth` / `rowBudget` 懒求值） | 不变。唯一要补的是**盒子高度吃满预算**（`fill: true`）——现状"贴合内容"会缩成矮盒子，与截图的固定高框不同 |
| 13 | 位置读数 / 滚动条 | 右侧滚动条（`render_picker_content_inner` 内绘制） | `renderScrollInfoLine = false` + `getScrollInfo()`，读数写在**底边框右侧**（`╰── 1/17 ─╯`），`SelectDialog:544` | **保留 sph 现有写法**：底边框右侧报位置（`1/17`），不另画滚动条——全屏的框线只有一种画法，塞一根竖线进去是两套视觉 |

**三处有意保留的偏差 + 一处已按你的要求改掉**：

1. **不加右上的 `[✕]`**：sph 的关闭语义只有 Esc 一处（`MessageDialog.handleInput:610`、`InputDialog:584`）。加关闭钮就要新增命中区，而浮层内的鼠标坐标换算正是已知的坑（`RoundedDialogBox.handleMouse:170-185` 的注释记着一次「滚轮滚到一半再也下不去」）。`Esc close` 常驻 footer，可见性由它保证。
2. **分隔符用 `·` 不用 `|`**：sph 全屏的提示分隔符只有 `·` 一种（`dialogs.ts:57-59`），换成 `|` 会与其它弹窗的底边框提示两套写法并存。
3. **颜色用 sph 主色紫而非 grok 的单色白**：`PALETTE.primary = #9d7cd8`，主题是用户可覆盖的（`~/.sph/theme.json`），换成白色等于绕开主题层。

**已按你的要求改掉的一条**：报告弹窗边框**改直角**（原方案曾建议保留 `╭─╮`，理由是 `text/utils.ts:1412-1416` 说"整屏的横线只有这一种画法"）。实现方式是给 `renderRoundedBox` 加一个 `corners: 'round' | 'square'` 参数、**默认 `round`**，报告弹窗显式传 `square`——这样只有一个字形分支的差异，不会把圆角框从代码里删掉（其余弹窗继续用它）。

顺带一个副作用要说明：`renderRoundedBox` 同时被 **编辑器框、补全菜单、内联菜单、所有浮层弹窗** 调用，加参数是纯增量；但如果后续决定"全部改直角"，那就是一次性改掉全屏所有框的观感。

---

## 七、影响范围与风险

### 7.1 影响范围

**直接改动**：
- 一期：`/skills`、`/plugins`、`/help`、`/permissions` 四个只读报告；
- 二期（宿主 B）：`/history`、`/prompts`、`/mcps` 动作菜单 —— 获得搜索与分组折叠；
- 二期（宿主 C）：`/model`、`/provider`×3、`/effort`、`/permission`、`/notify`、`/resume`、命令面板 —— 获得默认过滤与分组折叠；
- 二期：`/mcps` 报告并入 `mcpTab`。
**间接受影响**：
- `src/tui/widgets/select-list.ts` 是**三套机制**的共用件（报告 / 浮层选择 `SelectBody` / 内联菜单 `showInlineMenu`），也被编辑器补全菜单用（`editor.ts:2419/2436`），扩展必须向后兼容；
- `src/tui/input/editor.ts` 的菜单渲染（`:604-632`）**同时服务补全菜单与内联菜单** —— 改框件/提示/分组会连带 `/`、`@` 补全菜单；
- `renderRoundedBox` 被编辑器框、补全菜单、内联菜单、全部浮层调用 —— 加 `corners` 是纯增量，但"全改直角"会一次性动全屏；
- `dialogs.ts` 的 `compactHint` 被四个 `DialogBody` 共用，删除要同步改四处；
- `dialog-render.test.ts` 里 `/help 不再有可点选的列表` 这条断言的前提被推翻（报告从"纯文本"变成"可选列表"）。

**明确不受影响**：`trust/*`、审批框与计划复核的正文、`Markdown` 控件；三套弹窗的**定位语义**（挂输入框上方 vs 浮层居中）不变。

### 7.2 风险与缓解

| # | 风险 | 严重度 | 缓解 |
|---|---|---|---|
| R1 | **测试面大**：`reports.test.ts`(32) + `dialog-render.test.ts`(24) + `dialogs.test.ts`(11) ≈ 67 个用例，其中约 30 个会因为"报告从字符串变数据"而必须重写 | **高** | S0 先给现状加渲染基线锁住观感，再动结构；测试迁移与实现分两提交 |
| R2 | **四处行预算同源**（`rowBudget` :82 / `RoundedDialogBox` :132 / `DialogBody` :218 / `renderRoundedBox` :1389）。报告多出 tab+搜索+分隔线+footer 共 4 行固定开销，算错就表现为"矮终端下底边框消失"——注释里已记录过这个坑（`dialogs.ts:6-8`、`:134-136`） | **高** | chrome 行数一次算清、只在一处减（`report/body.ts`）；补矮终端（rows=12/16）渲染用例断言底边框仍在 |
| R3 | **鼠标坐标换算**：`RoundedDialogBox.handleMouse`(:170-185) 把坐标减 `1 + PAD_X` 后交给子组件。新增 tab 行/搜索行后行偏移要重算，漏算就点错行。注释里已记录过同类 bug（`:174-177`「滚轮滚到一半再也下不去」） | 中 | `ReportBody` 显式持有每段的 `top/rows`（现有 `SelectBody.listTop/listRows` 是同一手法）；补点选用例 |
| R4 | **画布底色**：报告弹窗走 `transparent: true`（铺画布底而非 `dialogBg`）。新增的 tab 行 / 搜索行 / footer 行必须也铺，否则出现"抠掉一块露出底色"——`fillDialogSurface`(:39-55) 整段注释就是在讲这个 | 中 | 新增行一律走 `fillDialogSurface`；补一行断言"整行底色一致" |
| R5 | **搜索 × 折叠 × 选中的三方交互**：过滤后选中索引可能停在被过滤掉的行上；搜索强制展开与用户折叠状态要能还原 | 中 | 过滤后重新夹取选中到最近可选项（grok 的 `first_selectable_index` 就是修这个，`extensions_modal.rs:3529`）；「搜索展开」只看不改 |
| R6 | **`SelectList` 是共用件**：`kind:'group'` 不能改变 `'header'` 语义；`setFilter` 的前缀匹配被编辑器补全菜单依赖（`editor.ts:2419/2436`） | 中 | 新增 `matcher` 注入点而不改 `setFilter` 默认行为；`select-list.test.ts` 全绿是前置条件 |
| R7 | **`/mcps` 功能回退**：sph 的 `/mcps` 是**管理器**（启停/新增/删除/重载，`mcp-commands.ts:59/189`），不是只读报告。一期若把它并进只读面板，会丢动作 | **高** | 一期 `/mcps` **不进面板**，保持现状；二期在 tab 上接 `ReportAction`（grok 的 MCP tab 正是 `space/a/x/r` 这几个键）后再迁 |
| R8 | **`prose` / `code` 块的边界**：MCP 空态的 toml 示例、`/help` 尾部的队列说明不是条目结构，强行拆碎会不可读 | 低 | 模型里保留 `prose`/`code` 两种块，块内继续走 `Markdown`；测试覆盖"块顺序与原文一致" |
| R9 | **`/help` 的键位清单与新 footer 再次分家**：`/help` 从 `APP_KEYBINDINGS` 取数，footer 若另起一份就又回到 P6 | 中 | footer 项也进 `report/registry.ts`，由同一份声明产出；补一条断言"footer 里出现的键在 Keys tab 里能找到" |
| R10 | **定位改成居中是改设计意图，会影响所有走 `commandPanelOptions` 的弹窗**：`/skills` `/plugins` `/help` `/resume` `/history` `/docs` 共用它，`row = 10%` 是**有意**的"就地展开"（`dialogs.ts:698-705`） | 中 | 只在 `showReportDialog` 里不传 `row`，`commandPanelOptions` 本身不动 → 报告居中、其余保持原样；是否统一改由用户拍板（§4.8 末尾） |
| R11 | **盒子吃满预算会改变"矮终端下的失败模式"**：现在内容少则盒子矮、不会顶穿；`fill: true` 后盒高恒等于 `rowBudget`，一旦 chrome 行数算错就直接把底边框顶掉（与 R2 同源，但暴露面更大） | 中 | `fill` 默认 `false`，只有报告开；补 rows=12/16/24 三档渲染用例断言"底边框 + footer 都在" |
| R12 | **清 `anchor` 死配置可能踩到别的调用方**：`overlayOptions` 是 `showSelectDialog`/`showInputDialog`/`showMessageDialog`/`showLoadingDialog` 共用的 | 低 | 清理只做"二者留一"的收敛，不改默认值；`dialogs.test.ts` 的 11 个用例断言的就是这批 `maxWidth`/档位，跑通即安全 |
| R13 | **`SelectList` 是三套弹窗的共用件**：报告（本次新增调用）、浮层选择弹窗（`SelectBody`）、内联菜单（`showInlineMenu`）+ 编辑器补全菜单（`editor.ts:2419/2436`）。`kind:'group'` 若改动 `kind:'header'` 的现有语义，会同时打坏 `/model` 的 provider 分组、`/mcps` 的 Actions/Servers 分段、`/notify` 的通道说明行、`/history` 的号槽 | **高** | ① `'group'` 是**新增** kind，`'header'` 一个字不改；② `matcher` 是**新增可选参数**，`setFilter` 的 `startsWith` 默认行为保持不变（一期报告不用 `setFilter`，走自己的 `search.ts`）；③ 前置条件：`tests/tui/widgets/select-list.test.ts`(243 行) + `tests/tui/input/editor-*.test.ts`(224 行) + `dialog-render.test.ts` 的 `/resume`/`/permission` 用例全绿 |
| R14 | **`/history` 与 `/resume` 的过滤能力差异是历史遗留**，二期给 `/history` 补过滤等于**改它的交互**（从"只能翻"变成"能打字的"），而这套浮层弹窗的键位路由（`SelectDialog.handleInput` → `SelectBody.handleNav` → `list.handleInput`）目前**没有文本输入的通道**——`SelectBody` 只转发导航键 | 中 | 二期：`SelectBody` 需要一条"打字进查询"的通路（内联菜单的 `applyMenuFilter` 是现成模板，`editor.ts:2406-2428`）；一期不动，只在方案里记下 |
| R15 | **改内联菜单会连带改掉 `/`、`@` 补全菜单**：两者走同一处渲染（`editor.ts:604-632` 的 `activeMenu()`），且注释写明内联菜单「与补全菜单同一圆角边框盒」（`:2366`）。补全菜单是**高频可见**的（每次敲 `/` 或 `@` 都出现），它的观感变化比参数选择器影响面大得多 | **高** | ① 接受连带（推荐）：两套菜单本来就长得一样，一起改更一致，但要在 S0 基线里把补全菜单的渲染也拍下来；② 若要隔离，就得把 `:604-632` 拆成两条渲染——**那正是本次要消除的重复**，不推荐。需要用户明确选一个 |
| R16 | **`showInlineMenu` 默认开过滤会改变命令面板的行为**：`filterable` 现在只有 `/resume` 传，命令面板（`interactive-mode.ts:1473`）走的是另一条 `SelectList.setFilter` 路径。默认开启后，命令面板、`/model` 等会**全部开始吃字符输入**——如果某处依赖"字母键直接触发动作"，会被吞掉 | 中 | 默认开启前先逐个确认调用点：`settings-commands.ts:92/133/197/250/265/335/374`、`session-commands.ts:148`、`interactive-mode.ts:1473`。`applyMenuFilter` 已经会吞掉可打印字符（`:2423-2426`），所以这些菜单里**不能再有单字母快捷键**——现状下它们本来也没有，但要在迁移时核对 |

---

## 八、实施顺序（每步独立可编译、可回滚）

| 阶段 | 内容 | 验证 |
|---|---|---|
| **S0** | 只加测试：给现有 5 份报告的渲染加基线断言（锁住当前观感与行预算行为，含矮终端底边框） | `npm run typecheck` + `npm test` |
| **S1** | `report/doc.ts` + `report/sources/skills.ts`（纯数据），不动任何 UI；配套数据断言测试 | 新测试通过，现有测试全绿 |
| **S2** | `tab-bar.ts` + `search-bar.ts` + `report/body.ts` + `report/dialog.ts`，**只接 `/skills` 一个入口灰度**（单 tab） | `/skills` 相关用例 + 新增渲染用例 |
| **S3** | 折叠 + 搜索 + 筛选档 + footer 注册表；删除 `HINT_KEYS` / `compactHint` | 搜索/折叠/短路用例 |
| **S4** | 接入 `plugins` / `permissions`，并把 `help` 拆成 `commands` + `keys` 两个 tab（面板第一次真正多 tab） | 四条端到端用例迁移完成 |
| **S5** | 清空 `reports.ts` 为 `report/sources/*`，删除四个转义工具与全部字符串拼接 | 全量 `npm test` |
| **S6**（二期·宿主 B） | `showSelectDialog` 接入搜索 + 分组：`SelectBody` 补**字符输入通路**（照 `editor.ts:2406-2428` 的 `applyMenuFilter`）；`/history` 按日期分组、时间戳退成尾列；`/mcps` 动作菜单、`/prompts` 同步受益 | `/history`、`/mcps` 用例；`dialog-selection.test.ts` 全绿 |
| **S7**（二期·宿主 C） | `showInlineMenu` 默认开过滤（逐点核对 R16）、`editor.ts:619-621` 两串手写提示改共用派生、`/model` 的 provider 分组变可折叠。**连带改掉 `/`、`@` 补全菜单**（R15，需先确认） | `editor-*.test.ts`(224 行) + `select-list.test.ts`(243 行) + `dialog-render.test.ts` 的 `/resume`/`/permission` 用例 |
| **S8**（二期收尾） | `renderRoundedBox` 的 `corners` 参数按最终决定推广；`/mcps` 报告并入 `mcpTab` | 全量 `npm test` + minimal 模式渲染用例 |

---

## 附：与 grok 参考实现的取舍

**可以照搬的思路**
- 「一个弹窗、多个 tab、命令只在 tab 上落点」——`/skills` 打开面板停在 Skills tab；
- 「搜索时强制展开」——否则命中的条目藏在折叠组里等于没搜；
- 「分组头既是折叠开关又是可选中行」（grok 把组头当普通行 + `entry_group_keys`，而不是装饰性 header）；
- 「footer 居中 + 键加粗」的视觉；
- 「内容顶部对齐、溢出才滚」。

**不要照搬的部分**
- **绝对不要搬它的代码结构**：grok 的 `render_extensions_modal` 是 1278 行单函数、`ExtensionsModalState` 54 字段、13 个必须人工对齐的平行列向量（详见 grok 侧分析）。sph 的取向是"一个人能读完"（README:Provenance），报告数据必须是**具名类型**而不是列数组。
- **不要引入 tab 焦点与列表焦点的双状态**：grok 里 `ModalWindowState.tabs_focused` 与 `picker_state` 两套焦点要靠调用方手工同步，是 bug 温床。sph 的 tab 切换走 `Tab` 键、由 `ReportDialog` 单点持有"焦点在 tab 栏还是列表"。
- **不要照搬它的键位映射三份维护**（`extensions_action_keys` / `resolve_key` / `tab_all_hints`）——sph 用一份 `ReportAction`。
- **不要照搬方角边框与 `[✕]`**：与 sph 的圆角框统一画法冲突，且 sph 的关闭语义已经只有 Esc 一处，再加一条鼠标路径是净增成本。
