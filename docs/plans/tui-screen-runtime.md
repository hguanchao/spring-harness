# TUI 格子运行时重写方案

状态：待实施  
日期：2026-09-28  
范围：用 `src/screen` 替换 `src/tui` 的绘制契约，再把 `sph-tui` 切过去。产品命令、会话和工具循环不动。

## 1. 结论

推翻现在的「组件树返回 ANSI 字符串」契约，做成 sph 自己的格子运行时。

应用持有数据。每一帧只把可见区域画进格子缓冲。样式、光标、链接、选区都是格子上的字段。终端差分只在写出时发生一次。

终端协议和编辑语义留下：Kitty 键盘、SGR 鼠标、括号粘贴、同步输出、纵向滚动区平移、硬件光标、东亚宽度、`marked` 解析。这些不重写。

新代码放在 `src/screen/`。旧的 `src/tui` 保持可编译，直到交互会话能打字、补全、审批、滚动、划词、流式输出。切完再删旧目录。中间不做 `render(): string[]` 兼容层。

## 2. 现状

控件种类很少：`Text`、`Box`、`Spacer`、`Loader`、`VStack`、`ScrollView`、`SelectList`、`Input`、`Editor`、`Markdown`。重量在绘制模型，不在控件数量。

`src/tui` 与 `sph-tui` 的非空行用 PowerShell `(Get-Content).Measure-Object -Line` 统计（2026-09-28）：

| 位置 | 非空行 | 最大的文件 |
|---|---:|---|
| `src/tui` | 约 12100 | `editor.ts` 2103，`tui-alt-screen.ts` 1532，`utils.ts` 1355，`tui.ts` 1262 |
| `src/plugins/sph-tui` | 约 7900 | `interactive-mode.ts` 1740 |
| `tests/tui` | 34 个测试文件 | 框架行为与产品界面混在一起 |

### 2.1 字符串就是场景

每个控件的出口是 `render(width): string[]`。颜色、光标标记（`CURSOR_MARKER`）、OSC 8 链接、OSC 133 区标都烤进字符串。后面的布局、鼠标命中、浮层合成（`compositeTuiLine`）、划词（`applySelectionHighlight`）、行差分（`paintScreenDiff`）再把字符串拆开。`utils.ts` 的绝大部分是这条链路。

缓存按整行字符串比较。于是运行时对产品暴露两套失效：

- `invalidateContent`：转录内容变了，滚动缓存作废
- `requestViewportRender`：滚动、选区、底栏动画，只重画当前帧

`interactive-mode.ts`、`Editor`、子代理块都要自己判断该调哪一个。流式输出一个 token 时，历史消息的字符串仍会被重新走过。

### 2.2 两套模型叠在一起

组件树是可变的（`addChild` / `removeChild` / `invalidate`）。`layout.ts` 再做第二遍 flex（`grow` / `shrink`）、滚动裁剪和滚动条拼接。鼠标命中有时会再 `render` 一遍子节点，只为了知道高度（`Box.handleMouse`）。

这既不是细粒度响应式，也不是即时模式。身份、缓存、整棵子树的字符串重建都要付。

`tui.ts` 同时放着组件契约、焦点、浮层栈、输入调度和行合成。`tui-alt-screen.ts` 同时放着备用屏幕、选区、滚轮、差分和 SGR 鼠标解码。`editor.ts` 同时放着文本缓冲、撤销、补全弹层、斜杠命令和路径触发。

### 2.3 框架知道产品

这些今天在 `src/tui`，它们属于 `sph-tui`：

- `findFdBinary`、文件系统补全、`@` `#` 触发、斜杠命令类型（`autocomplete.ts`）
- 粘贴占位 `[paste #N]`（`editor.ts`）
- `fuzzyFilter`（只服务补全）
- `formatStatusElapsed` / `formatStatusTokens`（`primitives.ts` 引用 `src/util.ts`）
- `escapeRegExp` 从 `src/util.ts` 再导出（`utils.ts`）
- `index.ts` 再导出 `marked` 的 `Marked`、`Token`、`Tokens`

主题在 `sph-tui/theme` 已经是命名色板（`PALETTE` 的 `bg`、`text`、`primary` 等）。框架侧的契约仍是 `(text: string) => string`。`Box` 用 `bgFn("test")` 的采样结果判断背景有没有变。

依赖方向今天基本正确：`src/tui` 不引用会话、工具、权限。例外就是上面两处对 `src/util.ts` 的引用。新运行时把这个例外收掉。

### 2.4 必须留下的行为

这些是协议或已经测过的交互，重写时对齐现有测试，不顺手改语义：

- Kitty 键盘协议、`modifyOtherKeys`、Windows Terminal 差异、原生 Shift+Enter（`keys.ts`、`terminal.ts`）
- 括号粘贴（`editor-support.ts`）
- SGR 鼠标（`1006`）与旧式 `ESC [ M`，滚轮、拖选、双击词、三击行（`tui-alt-screen.ts`）
- 备用屏幕 `1049`、鼠标跟踪、焦点进出、同步输出 `2026`
- `paintScreenDiff`：宽度或高度变了才清屏；未改的行跳过；整段上下平移时用滚动区 `S` / `T`，不逐行重写
- 清行用默认底（SGR 49），不用真彩 `48;2`，避免 Windows Terminal 画出浅带
- 硬件光标摆到编辑位置，给输入法候选窗用
- 东亚宽字符、字素簇（`get-east-asian-width` + `Intl.Segmenter`）
- 浮层优先级、焦点归还、点击浮层外不把底层编辑器抢走
- 选区不跨块（今天的 `SELECTION_BLOCK`）。工具行双击是展开/收起，不升级成选词（今天的 `SUPPRESS_MULTI_CLICK_SELECTION`）
- 用户消息吸顶：滚过气泡后钉在视口顶，高度收到最多 5 行，下一条用户消息把它顶走（`sticky-user-message.ts`）
- OSC 133：用户消息和助手消息包一层，给终端标出输入/输出区（`wrapOsc133Zones`）
- OSC 8 超链接，能力探测在 `terminal-image.ts`
- 帧合并约 16ms；键盘输入走 `nextTick` 抢在节流帧之前（`TuiBase.MIN_RENDER_INTERVAL_MS`）
- `SPH_THEME=terminal` 只发基础 ANSI，画布底回到终端默认背景。`NO_COLOR` / `FORCE_COLOR` 继续生效
- Markdown 用 `marked`，删除线走现有的严格分词（两侧不能是空白）

## 3. 设计

Element Plus 站在 Vue 上：设计令牌、数据向下、事件向上、控件组合、虚拟列表、浮层单独成系统。它不自己实现 DOM。

sph 缺的是那层运行时。格子缓冲承担 DOM 的角色。控件是往格子里画的函数。`sph-tui` 持有模型，相当于页面。

不引入 Vue、React、Ink，也不做 CSS 引擎。一帧终端大约一两万格，整帧调用视图函数是便宜的。贵的是把全部历史烤成 ANSI 再解析。

### 3.1 分层

```
sph-tui          模型、命令、转录块、对话框、主题色板、补全
    │  view(frame, model) / update(model, msg)
src/screen       格子、布局、焦点、浮层、输入、差分、少量控件
    │
终端             stdin 序列进，ANSI 出
```

`src/screen` 不引用 `src/plugins`、`src/agent`、`src/session`、`src/tools`、`src/util.ts`。允许的运行时依赖保持现状：`get-east-asian-width`；`marked` 只允许 `widgets/markdown.ts` 引用。

### 3.2 目录

```
src/screen/
  index.ts                 公开出口，短
  cell.ts                  Color、Style、Cell、Buffer
  diff.ts                  按行差分、同步输出、纵向平移
  text.ts                  字素宽度、按列切片、折行
  layout.ts                一次纵向 flex，矩形
  frame.ts                 Frame、Surface、焦点、浮层、命中目标
  host.ts                  start / stop、16ms 合并、requestFrame
  theme.ts                 写出时把 Color 变成 ANSI
  input/
    keys.ts                自 src/tui/keys.ts 迁入，不改协议
    stdin-buffer.ts
    terminal.ts
    native.ts
    mouse.ts               从 tui-alt-screen.ts 抽出的 SGR / 旧式鼠标解码
    terminal-image.ts      能力探测、OSC 8
  widgets/
    text.ts
    stack.ts
    scroll.ts              虚拟窗口 + 高度表
    select.ts
    loader.ts
    markdown.ts
    editor/
      buffer.ts            纯状态：光标、撤销、kill ring、词移动、括号粘贴
      view.ts              把缓冲画进格子，报告硬件光标格
```

产品侧补全、斜杠命令、`fuzzy`、`findFdBinary` 落到 `src/plugins/sph-tui/`，不进 `src/screen`。

### 3.3 绘制契约

控件不再是类，也不再返回字符串。一帧里登记矩形和回调。回调只在这一帧有效。

```ts
type Color =
  | { type: "default" }
  | { type: "ansi"; code: number }
  | { type: "rgb"; r: number; g: number; b: number };

type Style = {
  fg?: Color;
  bg?: Color;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** OSC 8。无能力时写出层忽略。 */
  link?: string;
};

type Rect = { x: number; y: number; width: number; height: number };

interface Surface {
  readonly rect: Rect;
  put(x: number, y: number, grapheme: string, style?: Style): void;
  /** 返回占用的列数。宽字符占两列，续列不单独放字素。 */
  text(x: number, y: number, value: string, style?: Style): number;
  clear(style?: Style): void;
  /** 标出这片矩形对应的 OSC 133 区。内容格子里不放转义序列。 */
  zone(kind: "prompt" | "output"): void;
  onMouse(handler: (event: MouseEvent) => void): void;
  /** 仅当前焦点 id 匹配时收到键。 */
  onKey(id: string, handler: (event: KeyEvent) => void): void;
}

interface Frame {
  readonly width: number;
  readonly height: number;
  area(rect: Rect): Surface;
  overlay(spec: OverlaySpec, view: (surface: Surface) => void): void;
  focused(id: string): boolean;
}

interface ScreenHost {
  start(view: (frame: Frame) => void): void;
  stop(): void;
  requestFrame(): void;
}
```

坐标都是 0 基、相对于该 `Surface`。命中测试用本帧登记的矩形，从浮层往下找。不再为了测高而调用 `render`。

有身份的状态放在应用模型里，只有三处：

| 状态 | 所有者 | 内容 |
|---|---|---|
| 编辑器缓冲 | `sph-tui` | 行、光标、撤销栈、kill ring |
| 滚动 | `sph-tui` | `offset`、是否贴底 |
| 选区 | `sph-tui` | `blockId` + 格偏移的锚点和焦点 |

`Text` 不缓存，也没有 `invalidate()`。公开 API 不提供 `render(): string[]`、`invalidate`、`invalidateContent`、`requestViewportRender`。

### 3.4 帧循环

`requestFrame` 把一帧合并到约 16ms，与现在的 `MIN_RENDER_INTERVAL_MS` 相同。输入路径用 `nextTick` 立刻画，抢在已经排上的节流帧之前，对应现在的 `requestImmediateRender`。

一帧的顺序：

1. `view(frame)` 把可见控件画进 `Buffer`，并登记命中矩形、焦点键处理、浮层、OSC 133 区。
2. 本帧到达的键和鼠标，按浮层优先、矩形从顶向下分发。
3. `diff.ts` 把这一帧格子和上一帧比较，写出 ANSI。
4. 编辑器若聚焦，把硬件光标放到它报告的那一格。未聚焦则隐藏光标。

差分规则对齐 `paintScreenDiff`：

- 宽或高变化：SGR 49 清屏，记一次全量重绘
- 行内容相同：跳过
- 检测到整段纵向平移：设置滚动区，发 `S` 或 `T`，立刻复位滚动区，只补新露出的行
- 整帧包在同步输出 `2026` 里
- 样式在写出时按行做游程编码。格子里存 `Style`，不存已经展开的 ANSI

### 3.5 布局

产品全屏只有一种骨架：顶栏固定、转录伸展、底栏（挂起条、状态、编辑器、页脚）按内容收缩。横向只做行内分列（选择列表的两列、页脚）。

`layout.ts` 提供一次纵向分配：`fixed` 或 `auto` 的条带加上一个 `grow` 区域。不做通用的约束求解器，也不把现在 `layout.ts` 的滚动条拼接、ANSI 裁剪搬过来。滚动条由 `widgets/scroll.ts` 在自己的矩形最右列画格子。

### 3.6 虚拟转录

转录是块数组，不是子组件列表。块由 `sph-tui` 定义：

```ts
type Block = {
  id: string;
  /** 内容或宽度语义变了才加。流式 token 只加最后一块。 */
  revision: number;
  measure(width: number): number;
  paint(surface: Surface): void;
};
```

`widgets/scroll.ts` 持有一张高度表，键是 `(id, width, revision)`。`paint` 只对与视口相交的块调用 `measure` 和 `paint`。revision 未变的块不进入 `measure`。

贴底：模型里 `followTail === true` 时，内容变高把 `offset` 推到末尾。用户向上滚动则关掉 `followTail`。这是现在滚到底再跟随的行为，收到滚动控件的状态里，不再用「内容世代」让整份转录缓存失效。

吸顶留在 `sph-tui`。滚动控件交出每个块的虚拟 y 和高度。吸顶算法继续用现在的规则：跳过块前的 `BLOCK_GAP` 才是气泡顶；最多 5 行；下一条用户消息靠近时顶走。绘制时在转录矩形顶部盖一层格子，不再 `compositeTuiLine`。

### 3.7 编辑器

`editor/buffer.ts` 是纯函数，不接触终端：

- 行数组、光标行、光标列
- 撤销栈、kill ring、按词移动（现有 `editor-support.ts`）
- 括号粘贴的开始/结束序列
- 现有编辑键位测试覆盖的动作

`editor/view.ts` 按宽度折行，把可见行画进 `Surface`，并给出硬件光标的屏幕格。聚焦边框是视图的事。

补全弹层、斜杠命令着色、`@` `#` 路径扫描不在编辑器里。`sph-tui` 根据缓冲文本决定要不要 `frame.overlay` 一个选择列表。选中一项后改缓冲。编辑器不知道斜杠命令和 fd。

`Input` 与 `Editor` 合成这一套。单行是「禁止换行的缓冲」。

### 3.8 主题

格子只存 `Color`。`theme.ts` 在写出时解析：

| 模式 | 行为 |
|---|---|
| `truecolor` | `38;2` / `48;2` |
| `256color` | 现有色立方 / 灰度近似 |
| `ansi`（`SPH_THEME=terminal`） | 基础 ANSI 前景与默认背景 |
| 颜色关闭（`NO_COLOR`、`FORCE_COLOR=0`） | 不发颜色 |

`sph-tui/theme/palettes.ts` 的键保留（`bg`、`text`、`primary`、`dialogBg`、`selectedBg`、`rowHoverBg` 等）。产品把 hex 转成 `{ type: "rgb" }` 再交给视图。`~/.sph/theme.json` 仍只覆盖已有键。框架不再接收上色函数，也不再调用函数来采样背景是否变化。

### 3.9 选区、链接、语义区

选区是模型字段：`{ blockId, anchor, focus }`。块的 `paint` 在对应格上铺 `selectedBg` 和对比字色。高亮因此走正常差分，不再在 ANSI 里每个 SGR 后面重申反显。

选区不能跨出 `blockId`。工具行如果声明自己处理双击，双击不升级成选词；拖选仍按字符。这两条是现在 `SELECTION_BLOCK` 和 `SUPPRESS_MULTI_CLICK_SELECTION` 的行为，改成块上的标志，由 `sph-tui` 解释。

`Style.link` 在写出层变成 OSC 8。`Surface.zone` 在写出层给对应行范围包上 OSC 133 的 A / B / C。布局和命中测试看不到转义序列。

右键复制当前应用内选区。这条保持现在的注释所写的原因：选区是应用自绘的，Windows 上右键若当粘贴，会用剪贴板覆盖刚选中的内容。

### 3.10 浮层与对话框

`OverlaySpec` 包含锚点、优先级、是否抢走键盘、以及按终端尺寸决定可见的函数。同一帧可以叠多层。命中和键盘都从优先级高的可见浮层开始。关闭浮层时把焦点还给打开它之前的 id。

`sph-tui` 可以继续把审批写成 Promise：

```ts
const choice = await openOverlay<ApprovalChoice>(host, spec, (surface, done) => {
  // 画对话框；用户选定后 done(choice)
});
```

`openOverlay` 只是在模型里放入 `overlay` 并在 `done` 时 resolve。它不持有组件实例。现有 `showSelectDialog` / `showInputDialog` / `showMessageDialog` 改成这种形状，优先级常量（如审批浮层）留在 `sph-tui`。

### 3.11 应用数据流

`interactive-mode.ts` 从「装配一棵组件树」改成「持有模型并提供 view」。

```ts
type Msg =
  | { type: "key"; event: KeyEvent }
  | { type: "mouse"; event: MouseEvent }
  | { type: "resize"; columns: number; rows: number }
  | { type: "agent"; event: AgentEvent }
  | { type: "overlay-done"; id: number; value: unknown };

type Model = {
  blocks: Block[];
  scroll: ScrollState;
  editor: EditorState;
  overlay?: OverlayState;
  selection?: SelectionState;
  followTail: boolean;
};
```

Agent 事件只改 `blocks` 里对应块的 `revision` 和文本，然后 `requestFrame()`。不再 `chatContainer.addChild`。

悬停和行选中也是模型字段（哪一个 `blockId`）。鼠标移出时视图自然不再画悬停底，不需要 `prepareMouseClick` / `finishMouseMotion` 这种运行时钩子。

## 4. 文件去向

| 现有文件 | 去向 |
|---|---|
| `keys.ts`、`stdin-buffer.ts`、`terminal.ts`、`native.ts`、`terminal-image.ts` | 迁入 `src/screen/input/`，协议不改 |
| `editor-support.ts` | 并入 `widgets/editor/buffer.ts` |
| `editor.ts` | 拆成 `buffer.ts` + `view.ts`。补全与斜杠移出 |
| `input.ts` | 单行模式的编辑器视图，类删除 |
| `autocomplete.ts`、`fuzzy.ts` | 移到 `src/plugins/sph-tui/` |
| `markdown.ts` | `widgets/markdown.ts`。停止从入口导出 `marked` |
| `primitives.ts`、`select-list.ts`、`scroll-view.ts` | 改成 `widgets/` 下的函数后删除类 |
| `layout.ts` | 换成一次 flex 和矩形命中 |
| `tui.ts`、`tui-alt-screen.ts` | 拆进 `frame.ts`、`host.ts`、`diff.ts`、`input/mouse.ts` |
| `utils.ts` | 宽度、字素、折行留在 `text.ts`。ANSI 拆串删除 |
| `keybindings.ts` | 键位表放进 `sph-tui`（`app-keybindings.ts` 已有产品键）。框架不再放全局 `getKeybindings()` |
| `alt-screen-flash.ts` | 留在 `sph-tui`，用格子覆盖实现 |
| `index.ts` | 由 `src/screen/index.ts` 替换 |

`sph-tui` 里直接引用 `tui/utils.js`、`tui/primitives.js`、`tui/layout.js`、`tui/tui.js` 的文件（吸顶、用户消息、助手消息）在阶段 3 改道，不保留深层路径。

## 5. 实施阶段

旧树在阶段 3 完成前继续作为 `sph` 的界面。新测试放在 `tests/screen/`。阶段 3 再把 `tests/tui` 中仍然描述产品行为的用例迁完并删掉旧测试。

### 阶段 1：运行时

不接 `sph-tui`。

- `cell.ts`、`text.ts`、`diff.ts`、`layout.ts`、`frame.ts`、`host.ts`、`theme.ts`
- 输入文件原样迁入，SGR 鼠标解码抽到 `input/mouse.ts`
- 测试：
  - 宽字符占两列，按列切片不拆开簇
  - 未改行不出现在输出里
  - 纵向平移走滚动区，滚动区随后复位
  - 尺寸变化才清屏，清屏序列使用 SGR 49
  - 浮层矩形挡住下层命中
  - 关闭浮层后焦点回到原来的 id
  - `ansi` 模式不发 `38;2` / `48;2`

完成标准：`tests/screen` 通过，`sph-tui` 仍引用 `src/tui`，`npm test` 通过。

### 阶段 2：控件

- `widgets/text.ts`、`stack.ts`、`scroll.ts`、`select.ts`、`loader.ts`、`markdown.ts`
- `widgets/editor/buffer.ts`、`view.ts`
- 把 `tests/tui/screen/editor-*.test.ts`、`keys.test.ts`、`stdin-buffer.test.ts`、`markdown.test.ts`、`scroll-view.test.ts`、`select-list.test.ts`、`utils*.test.ts`、`layout.test.ts` 中属于框架的断言迁到 `tests/screen/`
- 补一条虚拟列表测试：两个块，只增加第二块的 `revision`，第一块的 `measure` 调用次数为 0

完成标准：控件不返回 `string[]`。`marked` 只出现在 `widgets/markdown.ts`。编辑器缓冲测试不需要启动终端。

### 阶段 3：切换产品

- `interactive-mode.ts` 改为模型和 `view`
- 转录、对话框、页眉页脚、工具行、吸顶、悬停、主题改用 `src/screen`
- 补全与 `fuzzy`、`findFdBinary` 移入 `sph-tui`
- `tests/tui` 里组件、对话框、主题、权限、会话相关用例按新模型改写
- 删除 `src/tui`，产品进口改到 `src/screen/index.ts`
- `README.md` 架构一节里 `src/tui` 的描述改为 `src/screen`

完成标准：

- 交互路径覆盖：输入并换行、斜杠补全、审批浮层、滚轮、贴底跟随、划词不跨块、工具行双击不选词、用户消息吸顶、`SPH_THEME=terminal`
- `rg "src/tui" src tests` 无剩余引用
- `npm run typecheck` 与 `npm test` 通过

### 阶段 4：验收

- `src/screen` 非空行在 5500 以内（含迁入的键位协议和编辑器缓冲）
- 公开出口没有 `render(): string[]`、`invalidate`、`invalidateContent`、`requestViewportRender`、`Marked`、`findFdBinary`
- `src/screen` 不引用 `src/util.ts`
- 追加 token 时，revision 未变的历史块不会被 `measure`
- 未改变的格子行不出现在终端输出里

5500 行是预算，不是再拆文件的理由。协议解析和编辑器缓冲该长就留在预算里。超出预算时先砍 ANSI 兼容代码和产品逻辑，不砍测试里已经钉住的行为。

## 6. 风险

| 风险 | 处理 |
|---|---|
| 划词、吸顶、硬件光标缠在现在的字符串布局里 | 阶段 1、2 不删旧界面。阶段 3 以 `tests/tui/screen/tui-alt-screen.test.ts`、`editor-focus.test.ts`、`sticky-user-message.test.ts`、`tool-detail-selection.test.ts` 为对照 |
| Windows Terminal 的按键和清屏底色 | `keys.ts`、`terminal.ts` 不改；差分测试锁住 SGR 49 清屏 |
| 整文件替换中途 `main` 不可编译 | 新代码独立目录，阶段 3 一次切换进口 |
| 虚拟高度和折行不一致，导致滚动抖动 | 高度表的键包含 `width` 和 `revision`。折行只在 `measure` / `paint` 里做，两处共用同一个函数 |
| 吸顶算法在迁移时走样 | 阶段 3 先迁 `sticky-user-message` 的纯计算测试，再接绘制 |

## 7. 明确不做

- 不引入渲染库或虚拟 DOM
- 不保留 `render(): string[]` 适配层
- 不自写 Markdown 解析器，继续用 `marked`
- 不重写 Kitty / 鼠标协议解析
- 不把 Element Plus 的表单、表格、日期等控件搬进终端
- 不改 agent 循环、会话格式、权限和插件协议
- 不在本方案里改色板的具体色值
