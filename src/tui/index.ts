/**
 * 终端控件层入口。
 *
 * 组件、输入和备用屏幕都从这里出去。产品自己的命令和消息块留在调用方，
 * 这一层不引用会话、工具或权限。
 *
 * 目录按功能模块分：screen（屏幕与渲染内核）、terminal（终端接入）、
 * input（输入）、widgets（可复用控件）、text（文本度量与 ANSI）。
 * 导出顺序沿用这个分组，方便对照源码位置。
 *
 * 启动路径上的调用方（信任页、插件入口）**不要**走这里，改取深路径：本文件是静态
 * re-export，引一次就是整层——编辑器、markdown（连带 marked）、备用屏幕差分绘制全来了。
 * 主界面栈反正要全量加载，走这里没问题。
 */

export { Marked, type Token, type Tokens } from "marked";

// screen —— 屏幕、布局与备用屏幕
export {
	type Component,
	Container,
	SELECTION_BLOCK,
	SUPPRESS_MULTI_CLICK_SELECTION,
	CURSOR_MARKER,
	compositeTuiLine,
	type Focusable,
	isFocusable,
	isViewportTUI,
	resolveOverlayWidth,
	type OverlayAnchor,
	type OverlayBounds,
	type OverlayHandle,
	type OverlayMargin,
	type OverlayOptions,
	type OverlayUnfocusOptions,
	type SizeValue,
	type TUI,
	type TuiInputListener,
	type TuiInputListenerResult,
	type TuiMode,
	type TuiMouseButton,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	type TuiMouseEventType,
	type TuiStopOptions,
	type ViewportTUI,
} from "@/tui/screen/tui.js";
export {
	TuiAltScreen,
	type SelectionHighlight,
	type TuiAltScreenOptions,
	type ViewportChrome,
	type ViewportOverlayRect,
} from "@/tui/screen/tui-alt-screen.js";

// terminal —— 终端接入（TTY、按键、stdin、原生助手）
export {
	decodeKittyPrintable,
	isKeyRelease,
	isKeyRepeat,
	type KeyEventType,
	type KeyId,
	matchesKey,
	parseKey,
	setKittyProtocolActive,
} from "@/tui/terminal/keys.js";
export { StdinBuffer, type StdinBufferEventMap, type StdinBufferOptions } from "@/tui/terminal/stdin-buffer.js";
export { ProcessTerminal, type Terminal } from "@/tui/terminal/terminal.js";
export {
	detectCapabilities,
	getCapabilities,
	hyperlink,
	setCapabilities,
	type TerminalCapabilities,
} from "@/tui/terminal/terminal-image.js";

// input —— 编辑器、单行输入、补全与键位
export {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	CombinedAutocompleteProvider,
	findFdBinary,
	type SlashCommand,
} from "@/tui/input/autocomplete.js";
export { Editor, type EditorOptions, type EditorTheme } from "@/tui/input/editor.js";
export { type FuzzyMatch, fuzzyFilter } from "@/tui/input/fuzzy.js";
export { Input } from "@/tui/input/input.js";
export {
	formatKeyText,
	getKeybindings,
	type Keybinding,
	type KeybindingDefinition,
	type KeybindingDefinitions,
	type Keybindings,
	KeybindingsManager,
	TUI_KEYBINDINGS,
} from "@/tui/input/keybindings.js";

// widgets —— 可复用控件
export {
	BLOCK_GAP,
	Box,
	Loader,
	MouseRegion,
	Spacer,
	Text,
	type LoaderIndicatorOptions,
	type MouseRegionHandler,
	type StackChild,
	type StackEntry,
	type StackEntryOptions,
	type StackOptions,
	VStack,
} from "@/tui/widgets/primitives.js";
export { type DefaultTextStyle, Markdown, type MarkdownOptions, type MarkdownTheme } from "@/tui/widgets/markdown.js";
export {
	ScrollView,
	type ScrollViewOptions,
	type ScrollViewScrollbar,
	type ScrollViewScrollToOptions,
} from "@/tui/widgets/scroll-view.js";
export {
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type SelectListTheme,
	type SelectListTruncatePrimaryContext,
} from "@/tui/widgets/select-list.js";

// text —— 文本度量与 ANSI 处理
export {
	clipLineToWidth,
	contentVisibleWidth,
	getOsc8LinkAtColumn,
	OSC133_ZONE_PREFIX,
	sliceByColumn,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@/tui/text/utils.js";
