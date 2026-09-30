import { Marked, type Token, Tokenizer, type Tokens } from "marked";
import { getCapabilities, hyperlink } from "@/tui/terminal/terminal-image.js";
import type { Component } from "@/tui/screen/tui.js";
import { applyBackgroundToLine, ruleHeadingLine, visibleWidth, wrapTextWithAnsi } from "@/tui/text/utils.js";

const STRICT_STRIKETHROUGH_REGEX = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

class StrictStrikethroughTokenizer extends Tokenizer {
	override del(src: string): Tokens.Del | undefined {
		const match = STRICT_STRIKETHROUGH_REGEX.exec(src);
		if (!match) {
			return undefined;
		}

		const text = match[2];
		return {
			type: "del",
			raw: match[0],
			text,
			tokens: this.lexer.inlineTokens(text),
		};
	}
}

/**
 * 按 applyText 逐段上色后保留换行:内联样式函数不感知换行,先分段再拼回。
 * 提到模块级——renderInlineTokens 递归且高频,原闭包每次调用都重新分配。
 */
function applyTextWithNewlines(text: string, applyText: (segment: string) => string): string {
	return text
		.split("\n")
		.map((segment) => applyText(segment))
		.join("\n");
}

/**
 * 「词项 + 说明」列表的排版常量。见 `MarkdownOptions.termColumnLists`。
 */
/** 词项列的上限：再宽就会把说明挤成一列竖字。 */
const TERM_COLUMN_MAX = 24;
/** 说明列的保底下限：窄终端里优先保说明，词项超出上限就自己占一行。 */
const TERM_COLUMN_MIN_DESCRIPTION = 16;
/** 词项后面那个连接号（` — `）。有了列轨它就是多余标点。 */
const TERM_CONNECTOR = /^\s+(?:[—–:]\s+|-\s+)/;

/** 把已经上色的文本补到指定可见宽度。 */
function padVisible(text: string, width: number): string {
	return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

/**
 * h3 及以上画成「─ 标题 ───…」横线，线条铺满内容宽（字形见 ruleHeadingLine）。
 * 源码仍写 `### Skills 5`；井号前缀不进画面。
 */
function trimPartialClosingFences(tokens: readonly Token[]): void {
	const token = tokens[tokens.length - 1];
	if (token?.type === "list") {
		trimPartialClosingFences(token.items[token.items.length - 1]?.tokens ?? []);
		return;
	}
	if (token?.type === "blockquote") {
		trimPartialClosingFences(token.tokens ?? []);
		return;
	}
	if (token?.type !== "code") {
		return;
	}

	// 流式输出时闭合围栏会逐字到达。半截围栏留在 token 里会让代码块先变高再缩回去。
	// 末行只是围栏字符的前缀时先剪掉，等完整围栏到了再收口。
	const marker = /^(`{3,}|~{3,})/.exec(token.raw)?.[1];
	const lastLine = token.raw.split("\n").pop();
	if (!marker || !lastLine || lastLine.length >= marker.length || lastLine !== marker[0]?.repeat(lastLine.length)) {
		return;
	}

	token.text = token.text.slice(0, -lastLine.length).replace(/\n$/, "");
}

const markdownParser = new Marked();
markdownParser.setOptions({
	tokenizer: new StrictStrikethroughTokenizer(),
});

/**
 * `{{次要信息}}` 内联标记：来源、根目录这类需要弱化的内容，主题画成蓝色（行内码同一档）。
 * 生成器负责不把 `}{` 放进内容；内容里真有 `}}` 时不匹配，原样输出花括号，无害降级。
 */
const SECONDARY_REGEX = /^\{\{([^{}\n]+)\}\}/;

/**
 * `%%弱化信息%%` 内联标记：技能路径这类「要看得见、但不该抢话」的内容，主题画成中性灰。
 *
 * 与 `{{…}}` 同一路数：内容**逐字保留**，不再过 markdown 的行内规则，所以路径里的反引号、
 * 下划线、星号都不会被当成标记吃掉——拿斜体承载路径恰好栽在这些字符上（`_a_` 会连下划线
 * 一起吞掉）。代价是内容不能含 `%`：不匹配时原样输出标记本身，无害降级。
 */
const MUTED_REGEX = /^%%([^%\n]+)%%/;

/**
 * `!!警示信息!!` 内联标记：确认框的后果句、报告里的 warning。主题画成 warning 橙。
 * 内容逐字保留、不过行内规则（与 `%%…%%` 同理）；内容不能含 `!`，不匹配时原样输出，无害降级。
 */
const WARNING_REGEX = /^!!([^!\n]+)!!/;

/**
 * `@@错误信息@@` 内联标记：加载失败的名字这类 error 级内容。主题画成 error 红。
 * 内容不能含 `@`，其余同上。
 */
const ERROR_REGEX = /^@@([^@\n]+)@@/;

markdownParser.use({
	extensions: [
		{
			name: "secondary",
			level: "inline",
			start(src: string): number | undefined {
				const index = src.indexOf("{{");
				return index === -1 ? undefined : index;
			},
			tokenizer(src: string): Tokens.Generic | undefined {
				const match = SECONDARY_REGEX.exec(src);
				if (!match) return undefined;
				return { type: "secondary", raw: match[0], text: match[1] };
			},
		},
		{
			name: "muted",
			level: "inline",
			start(src: string): number | undefined {
				const index = src.indexOf("%%");
				return index === -1 ? undefined : index;
			},
			tokenizer(src: string): Tokens.Generic | undefined {
				const match = MUTED_REGEX.exec(src);
				if (!match) return undefined;
				return { type: "muted", raw: match[0], text: match[1] };
			},
		},
		{
			name: "warning",
			level: "inline",
			start(src: string): number | undefined {
				const index = src.indexOf("!!");
				return index === -1 ? undefined : index;
			},
			tokenizer(src: string): Tokens.Generic | undefined {
				const match = WARNING_REGEX.exec(src);
				if (!match) return undefined;
				return { type: "warning", raw: match[0], text: match[1] };
			},
		},
		{
			name: "error",
			level: "inline",
			start(src: string): number | undefined {
				const index = src.indexOf("@@");
				return index === -1 ? undefined : index;
			},
			tokenizer(src: string): Tokens.Generic | undefined {
				const match = ERROR_REGEX.exec(src);
				if (!match) return undefined;
				return { type: "error", raw: match[0], text: match[1] };
			},
		},
	],
});

/**
 * Default text styling for markdown content.
 * Applied to all text unless overridden by markdown formatting.
 */
export interface DefaultTextStyle {
	/** Foreground color function */
	color?: (text: string) => string;
	/** Background color function */
	bgColor?: (text: string) => string;
	/** Bold text */
	bold?: boolean;
	/** Italic text */
	italic?: boolean;
	/** Strikethrough text */
	strikethrough?: boolean;
	/** Underline text */
	underline?: boolean;
}

/**
 * Theme functions for markdown elements.
 * Each function takes text and returns styled text with ANSI codes.
 */
export interface MarkdownTheme {
	/** depth 为 ATX 标题级别 1–6；省略时按 H2。 */
	heading: (text: string, depth?: number) => string;
	link: (text: string) => string;
	linkUrl: (text: string) => string;
	code: (text: string) => string;
	codeBlock: (text: string) => string;
	codeBlockBorder: (text: string) => string;
	quote: (text: string) => string;
	quoteBorder: (text: string) => string;
	hr: (text: string) => string;
	listBullet: (text: string) => string;
	bold: (text: string) => string;
	italic: (text: string) => string;
	/** 加粗着色；缺省回落到 bold（不加色，避免标题等已经上色的路径被盖掉）。 */
	strong?: (text: string) => string;
	/** 斜体着色；缺省回落到 italic。 */
	emphasis?: (text: string) => string;
	/** `{{次要信息}}`：来源、根目录这类要弱化的内容；缺省原样输出（含花括号）。 */
	secondary?: (text: string) => string;
	/** `%%弱化信息%%`：技能路径这类要退到背景里的内容；缺省原样输出（含百分号）。 */
	muted?: (text: string) => string;
	/** `!!警示信息!!`：后果句、warning；缺省原样输出（含叹号）。 */
	warning?: (text: string) => string;
	/** `@@错误信息@@`：加载失败的名字；缺省原样输出（含艾特）。 */
	error?: (text: string) => string;
	strikethrough: (text: string) => string;
	underline: (text: string) => string;
	/** 代码块每行的缩进，缺省两个空格。代码一律走 codeBlock，不再按语言上色。 */
	codeBlockIndent?: string;
}

export interface MarkdownOptions {
	/** Preserve source list markers instead of normalizing them. */
	preserveOrderedListMarkers?: boolean;
	/** Preserve source backslash escapes instead of normalizing escaped punctuation. */
	preserveBackslashEscapes?: boolean;
	/** Transform source Markdown before parsing, with the exact width available for content. */
	transform?: (markdown: string, availableWidth: number) => string;
	/**
	 * 把「每条都以行内码开头」的无序列表排成两列：词项列 + 说明列（折行悬挂到说明列），
	 * 词项后面的 ` — ` 连接号不再上屏。
	 *
	 * 默认关。转录里的模型输出也会写成 `- \`x\` — y`，但那里的连接号是模型自己的标点，
	 * 替它吃掉等于改用户的内容；报告弹窗的条目全是这一种形状，列轨才是它们要的排版。
	 * 判据是「整块每一条都符合」——有一条形不像词项表（如 `- **label** — state`），整块
	 * 退回普通列表，避免出现半转换的锯齿。
	 */
	termColumnLists?: boolean;
}

interface InlineStyleContext {
	applyText: (text: string) => string;
	stylePrefix: string;
	/**
	 * 行内代码（codespan）的着色；缺省用主题的 code。
	 *
	 * 引用块里要换成「不自己上色」——codespan 自带的前景色会在 `\x1b[39m` 之后把颜色
	 * 交还给终端默认值，于是同一行里引用是灰的、行内码是白的，从灰底里跳出来。
	 */
	codeStyle?: (text: string) => string;
}

export class Markdown implements Component {
	private text: string;
	private paddingX: number; // Left/right padding
	private paddingY: number; // Top/bottom padding
	private defaultTextStyle?: DefaultTextStyle;
	private theme: MarkdownTheme;
	private options: MarkdownOptions;
	private defaultStylePrefix?: string;

	// Cache for rendered output
	private cachedText?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		text: string,
		paddingX: number,
		paddingY: number,
		theme: MarkdownTheme,
		defaultTextStyle?: DefaultTextStyle,
		options?: MarkdownOptions,
	) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.theme = theme;
		this.defaultTextStyle = defaultTextStyle;
		this.options = options ? { ...options } : {};
	}

	setText(text: string): void {
		this.text = text;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		// Check cache
		if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
			return this.cachedLines;
		}

		// Calculate available width for content (subtract horizontal padding)
		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const text = this.options.transform?.(this.text, contentWidth) ?? this.text;

		// Don't render anything if there's no actual text
		if (!text || text.trim() === "") {
			const result: string[] = [];
			// Update cache
			this.cachedText = this.text;
			this.cachedWidth = width;
			this.cachedLines = result;
			return result;
		}

		// Replace tabs with 3 spaces for consistent rendering
		const normalizedText = text.replace(/\t/g, "   ");

		// Parse markdown to HTML-like tokens
		const tokens = markdownParser.lexer(normalizedText);
		trimPartialClosingFences(tokens);

		// Convert tokens to styled terminal output
		const renderedLines: string[] = [];

		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			const nextToken = tokens[i + 1];
			const tokenLines = this.renderToken(token, contentWidth, nextToken?.type);
			for (const tokenLine of tokenLines) {
				renderedLines.push(tokenLine);
			}
		}

		// Wrap lines (NO padding, NO background yet)
		const wrappedLines: string[] = [];
		for (const line of renderedLines) {
			for (const wrappedLine of wrapTextWithAnsi(line, contentWidth)) {
				wrappedLines.push(wrappedLine);
			}
		}

		// Add margins and background to each wrapped line
		const leftMargin = " ".repeat(this.paddingX);
		const rightMargin = " ".repeat(this.paddingX);
		const bgFn = this.defaultTextStyle?.bgColor;
		const contentLines: string[] = [];

		for (const line of wrappedLines) {
			const lineWithMargins = leftMargin + line + rightMargin;

			if (bgFn) {
				contentLines.push(applyBackgroundToLine(lineWithMargins, width, bgFn));
			} else {
				// No background - just pad to width
				const visibleLen = visibleWidth(lineWithMargins);
				const paddingNeeded = Math.max(0, width - visibleLen);
				contentLines.push(lineWithMargins + " ".repeat(paddingNeeded));
			}
		}

		// Add top/bottom padding (empty lines)
		const emptyLine = " ".repeat(width);
		const emptyLines: string[] = [];
		for (let i = 0; i < this.paddingY; i++) {
			const line = bgFn ? applyBackgroundToLine(emptyLine, width, bgFn) : emptyLine;
			emptyLines.push(line);
		}

		// Combine top padding, content, and bottom padding
		const result = emptyLines.concat(contentLines, emptyLines);

		// Update cache
		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedLines = result;

		return result.length > 0 ? result : [""];
	}

	/**
	 * Apply default text style to a string.
	 * This is the base styling applied to all text content.
	 * NOTE: Background color is NOT applied here - it's applied at the padding stage
	 * to ensure it extends to the full line width.
	 */
	private applyDefaultStyle(text: string): string {
		if (!this.defaultTextStyle) {
			return text;
		}

		let styled = text;

		// Apply foreground color (NOT background - that's applied at padding stage)
		if (this.defaultTextStyle.color) {
			styled = this.defaultTextStyle.color(styled);
		}

		// Apply text decorations using this.theme
		if (this.defaultTextStyle.bold) {
			styled = this.theme.bold(styled);
		}
		if (this.defaultTextStyle.italic) {
			styled = this.theme.italic(styled);
		}
		if (this.defaultTextStyle.strikethrough) {
			styled = this.theme.strikethrough(styled);
		}
		if (this.defaultTextStyle.underline) {
			styled = this.theme.underline(styled);
		}

		return styled;
	}

	private getDefaultStylePrefix(): string {
		if (!this.defaultTextStyle) {
			return "";
		}

		if (this.defaultStylePrefix !== undefined) {
			return this.defaultStylePrefix;
		}

		const sentinel = "\u0000";
		const styled = this.applyDefaultStyle(sentinel);
		const sentinelIndex = styled.indexOf(sentinel);
		this.defaultStylePrefix = sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
		return this.defaultStylePrefix;
	}

	private getStylePrefix(styleFn: (text: string) => string): string {
		const sentinel = "\u0000";
		const styled = styleFn(sentinel);
		const sentinelIndex = styled.indexOf(sentinel);
		return sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
	}

	private getDefaultInlineStyleContext(): InlineStyleContext {
		return {
			applyText: (text: string) => this.applyDefaultStyle(text),
			stylePrefix: this.getDefaultStylePrefix(),
		};
	}

	private renderToken(
		token: Token,
		width: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
	): string[] {
		const lines: string[] = [];

		switch (token.type) {
			case "heading": {
				const headingLevel = token.depth;
				const headingStyleFn = (text: string) => this.theme.heading(text, headingLevel);

				if (headingLevel >= 3) {
					const label = token.text.replace(/\s+/g, " ").trim();
					lines.push(ruleHeadingLine(label, width, headingStyleFn));
				} else {
					// h1/h2 保留行内样式；内联码在标题色里复原，不落到默认正文色。
					const headingStyleContext: InlineStyleContext = {
						applyText: headingStyleFn,
						stylePrefix: this.getStylePrefix(headingStyleFn),
					};
					lines.push(this.renderInlineTokens(token.tokens || [], headingStyleContext));
				}
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after headings (unless space token follows)
				}
				break;
			}

			case "paragraph": {
				const paragraphText = this.renderInlineTokens(token.tokens || [], styleContext);
				lines.push(paragraphText);
				// Don't add spacing if next token is space or list
				if (nextTokenType && nextTokenType !== "list" && nextTokenType !== "space") {
					lines.push("");
				}
				break;
			}

			case "text":
				lines.push(this.renderInlineTokens([token], styleContext));
				break;

			case "code": {
				const indent = this.theme.codeBlockIndent ?? "  ";
				const codeToken = token as Tokens.Code;
				lines.push(this.theme.codeBlockBorder(`\`\`\`${codeToken.lang || ""}`));
				for (const codeLine of codeToken.text.split("\n")) {
					lines.push(`${indent}${this.theme.codeBlock(codeLine)}`);
				}
				lines.push(this.theme.codeBlockBorder("```"));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after code blocks (unless space token follows)
				}
				break;
			}

			case "list": {
				const listLines = this.renderList(token as Tokens.List, 0, width, styleContext);
				lines.push(...listLines);
				// Don't add spacing after lists if a space token follows
				// (the space token will handle it)
				break;
			}

			case "table": {
				const tableLines = this.renderTable(token as Tokens.Table, width, nextTokenType, styleContext);
				lines.push(...tableLines);
				break;
			}

			case "blockquote": {
				const quoteStyle = (text: string) => this.theme.quote(this.theme.italic(text));
				const quoteStylePrefix = this.getStylePrefix(quoteStyle);
				const applyQuoteStyle = (line: string): string => {
					if (!quoteStylePrefix) {
						return quoteStyle(line);
					}
					const lineWithReappliedStyle = line.replace(/\x1b\[0m/g, `\x1b[0m${quoteStylePrefix}`);
					return quoteStyle(lineWithReappliedStyle);
				};

				// Calculate available width for quote content (subtract border "│ " = 2 chars)
				const quoteContentWidth = Math.max(1, width - 2);

				// Blockquotes contain block-level tokens (paragraph, list, code, etc.), so render
				// children with renderToken() instead of renderInlineTokens().
				// Default message style should not apply inside blockquotes.
				const quoteInlineStyleContext: InlineStyleContext = {
					applyText: (text: string) => text,
					stylePrefix: quoteStylePrefix,
					// 行内码跟着引用一起压暗：返回原文即不自己上色，颜色由外层引用样式提供。
					codeStyle: (text: string) => text,
				};
				const quoteTokens = token.tokens || [];
				const renderedQuoteLines: string[] = [];
				for (let i = 0; i < quoteTokens.length; i++) {
					const quoteToken = quoteTokens[i];
					const nextQuoteToken = quoteTokens[i + 1];
					renderedQuoteLines.push(
						...this.renderToken(quoteToken, quoteContentWidth, nextQuoteToken?.type, quoteInlineStyleContext),
					);
				}

				// Avoid rendering an extra empty quote line before the outer blockquote spacing.
				while (renderedQuoteLines.length > 0 && renderedQuoteLines[renderedQuoteLines.length - 1] === "") {
					renderedQuoteLines.pop();
				}

				for (const quoteLine of renderedQuoteLines) {
					const styledLine = applyQuoteStyle(quoteLine);
					const wrappedLines = wrapTextWithAnsi(styledLine, quoteContentWidth);
					for (const wrappedLine of wrappedLines) {
						lines.push(this.theme.quoteBorder("│ ") + wrappedLine);
					}
				}
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after blockquotes (unless space token follows)
				}
				break;
			}

			case "hr":
				lines.push(this.theme.hr("─".repeat(Math.min(width, 80))));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after horizontal rules (unless space token follows)
				}
				break;

			case "html":
				// Render HTML as plain text (escaped for terminal)
				if ("raw" in token && typeof token.raw === "string") {
					lines.push(this.applyDefaultStyle(token.raw.trim()));
				}
				break;

			case "space":
				// Space tokens represent blank lines in markdown
				lines.push("");
				break;

			default:
				// Handle any other token types as plain text
				if ("text" in token && typeof token.text === "string") {
					lines.push(token.text);
				}
		}

		return lines;
	}

	private renderInlineTokens(tokens: Token[], styleContext?: InlineStyleContext): string {
		let result = "";
		const resolvedStyleContext = styleContext ?? this.getDefaultInlineStyleContext();
		const { applyText, stylePrefix } = resolvedStyleContext;

		for (const token of tokens) {
			switch (token.type) {
				case "escape":
					result += applyTextWithNewlines(this.options.preserveBackslashEscapes ? token.raw : token.text, applyText);
					break;

				case "text":
					// Text tokens in list items can have nested tokens for inline formatting
					if (token.tokens && token.tokens.length > 0) {
						result += this.renderInlineTokens(token.tokens, resolvedStyleContext);
					} else {
						result += applyTextWithNewlines(token.text, applyText);
					}
					break;

				case "paragraph":
					// Paragraph tokens contain nested inline tokens
					result += this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					break;

				case "strong": {
					const boldContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += (this.theme.strong ?? this.theme.bold)(boldContent) + stylePrefix;
					break;
				}

				case "em": {
					const italicContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += (this.theme.emphasis ?? this.theme.italic)(italicContent) + stylePrefix;
					break;
				}

				case "codespan":
					result += (resolvedStyleContext.codeStyle ?? this.theme.code)(token.text) + stylePrefix;
					break;

				case "secondary": {
					// `{{…}}`：次要信息。主题没定义时原样输出（含花括号），不让内容凭空消失。
					result += (this.theme.secondary ?? (() => token.raw))(token.text) + stylePrefix;
					break;
				}

				case "muted": {
					// `%%…%%`：弱化信息（技能路径）。同上，主题缺席时原样输出，含标记。
					result += (this.theme.muted ?? (() => token.raw))(token.text) + stylePrefix;
					break;
				}

				case "warning": {
					// `!!…!!`：警示信息（后果句、warning）。主题缺席时原样输出，含标记。
					result += (this.theme.warning ?? (() => token.raw))(token.text) + stylePrefix;
					break;
				}

				case "error": {
					// `@@…@@`：错误信息（加载失败的名字）。同上。
					result += (this.theme.error ?? (() => token.raw))(token.text) + stylePrefix;
					break;
				}

				case "link": {
					const linkText = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					const styledLink = this.theme.link(this.theme.underline(linkText));
					if (getCapabilities().hyperlinks) {
						// OSC 8: render as a clickable hyperlink. The URL is not printed inline,
						// so we always show only the link text regardless of whether it matches href.
						result += hyperlink(styledLink, token.href) + stylePrefix;
					} else {
						// Fallback: print URL in parentheses when text differs from href.
						// Compare raw token.text (not styled) against href for the equality check.
						// For mailto: links strip the prefix (autolinked emails use text="foo@bar.com"
						// but href="mailto:foo@bar.com").
						const hrefForComparison = token.href.startsWith("mailto:") ? token.href.slice(7) : token.href;
						if (token.text === token.href || token.text === hrefForComparison) {
							result += styledLink + stylePrefix;
						} else {
							result += styledLink + this.theme.linkUrl(` (${token.href})`) + stylePrefix;
						}
					}
					break;
				}

				case "br":
					result += "\n";
					break;

				case "del": {
					const delContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.theme.strikethrough(delContent) + stylePrefix;
					break;
				}

				case "html":
					// Render inline HTML as plain text
					if ("raw" in token && typeof token.raw === "string") {
						result += applyTextWithNewlines(token.raw, applyText);
					}
					break;

				default:
					// Handle any other inline token types as plain text
					if ("text" in token && typeof token.text === "string") {
						result += applyTextWithNewlines(token.text, applyText);
					}
			}
		}

		while (stylePrefix && result.endsWith(stylePrefix)) {
			result = result.slice(0, -stylePrefix.length);
		}

		return result;
	}

	private getOrderedListMarker(item: Tokens.ListItem): string | undefined {
		const match = /^(?: {0,3})(\d{1,9}[.)])[ \t]+/.exec(item.raw);
		return match ? `${match[1]} ` : undefined;
	}

	private getUnorderedListMarker(item: Tokens.ListItem): string | undefined {
		const match = /^(?: {0,3})([-+*])(?:[ \t]+|(?=\r?\n|$))/.exec(item.raw);
		return match ? `${match[1]} ` : undefined;
	}

	/**
	 * 列表项正文的内联 token。marked 把条目正文放在第一个 token（紧凑列表是 `text`，
	 * 宽松列表是 `paragraph`）的 `tokens` 里，两个形状都认。
	 */
	private listItemInline(item: Tokens.ListItem): Token[] {
		const body = item.tokens?.[0] as { type?: string; tokens?: Token[] } | undefined;
		if (body === undefined || (body.type !== "text" && body.type !== "paragraph")) return [];
		return body.tokens ?? [];
	}

	/**
	 * 这条列表项是不是「词项 + 说明」：正文以行内码开头，且行内码后面只剩连接号或正文。
	 * 返回词项原文（未上色），不符合时 undefined。
	 */
	private getListItemTerm(item: Tokens.ListItem): string | undefined {
		if (item.task) return undefined;
		const inline = this.listItemInline(item);
		const first = inline[0];
		if (first?.type !== "codespan") return undefined;
		const next = inline[1];
		// 行内码后面还有内容时，必须正好是连接号——`- `a` `b`` 那种不是词项表。
		if (next !== undefined) {
			const rest = (next as { text?: string }).text ?? "";
			if (next.type !== "text" || (!TERM_CONNECTOR.test(rest) && rest.trim() !== "")) return undefined;
		}
		return (first as { text?: string }).text;
	}

	/**
	 * 本块的词项列宽；整块不是词项表时返回 undefined（调用方退回普通列表）。
	 * 宽度 = 最长词项 + 2 列间隙，受上限与说明列保底双重夹制。
	 */
	private getTermColumnWidth(token: Tokens.List, width: number, markerWidth: number): number | undefined {
		if (token.items.length === 0) return undefined;
		const contentWidth = Math.max(1, width - markerWidth);
		let widest = 0;
		for (const item of token.items) {
			const term = this.getListItemTerm(item);
			if (term === undefined) return undefined;
			widest = Math.max(widest, visibleWidth(term));
		}
		const cap = Math.min(TERM_COLUMN_MAX, Math.max(4, contentWidth - TERM_COLUMN_MIN_DESCRIPTION));
		return Math.min(widest + 2, cap);
	}

	/** 剥掉词项后面的连接号（` — `）。只动第一个 text 片段，正文里的破折号一律不碰。 */
	private stripTermConnector(tokens: Token[]): Token[] {
		const first = tokens[0] as { type?: string; text?: string; tokens?: Token[] } | undefined;
		if (first?.type !== "text" || first.tokens !== undefined) return tokens;
		const text = first.text ?? "";
		const stripped = text.replace(TERM_CONNECTOR, "");
		if (stripped === text) return tokens;
		if (stripped === "") return tokens.slice(1);
		return [{ ...first, text: stripped, raw: stripped } as unknown as Token, ...tokens.slice(1)];
	}

	/** 一条「词项 + 说明」：标记列 + 词项列，说明折行悬挂到说明列。 */
	private renderTermListItem(
		item: Tokens.ListItem,
		indent: string,
		marker: string,
		markerWidth: number,
		columnWidth: number,
		width: number,
		styleContext?: InlineStyleContext,
	): string[] {
		const lines: string[] = [];
		// 有序列表的号照画（它就是行内容），无序的留同宽占位以对齐相邻列表。
		const prefix = `${indent}${marker}${" ".repeat(Math.max(0, markerWidth - visibleWidth(marker)))}`;
		const rail = `${indent}${" ".repeat(markerWidth + columnWidth)}`;
		const style = styleContext ?? this.getDefaultInlineStyleContext();
		const inline = this.listItemInline(item);
		const termText = (inline[0] as { text?: string } | undefined)?.text ?? "";
		const styledTerm = `${(style.codeStyle ?? this.theme.code)(termText)}${style.stylePrefix}`;
		const description = this.renderInlineTokens(this.stripTermConnector(inline.slice(1)), style);
		const descWidth = Math.max(1, width - visibleWidth(rail));
		const wrapped = description.trim() === "" ? [] : wrapTextWithAnsi(description, descWidth);
		// 词项顶到上限还装不下时让它独占一行，说明退到下一行的说明列——不缩词项。
		if (visibleWidth(termText) + 2 <= columnWidth) {
			lines.push(prefix + padVisible(styledTerm, columnWidth) + (wrapped.shift() ?? ""));
		} else {
			lines.push(prefix + styledTerm);
		}
		for (const line of wrapped) lines.push(rail + line.replace(/^ /, ""));
		// 条目里的其余块级 token（嵌套列表、续段）接着排在说明列下。
		for (const token of (item.tokens ?? []).slice(1)) {
			const nested =
				token.type === "list"
					? this.renderList(token as Tokens.List, 1, descWidth, style)
					: this.renderToken(token, descWidth, undefined, style);
			for (const line of nested) lines.push(rail + line);
		}
		return lines;
	}

	/**
	 * Render a list with proper nesting support
	 */
	private renderList(token: Tokens.List, depth: number, width: number, styleContext?: InlineStyleContext): string[] {
		const lines: string[] = [];
		const indent = "    ".repeat(depth);
		// Use the list's start property (defaults to 1 for ordered lists)
		const startNumber = typeof token.start === "number" ? token.start : 1;
		// 号（有序列表）也要进列轨：`/permissions` 的规则行是「号 · 动作 · 规则」三列，
		// 号列宽按整块最大号算，不然 9→10 会把动作列推右一格。无序列表留同宽占位，
		// 词项列的左缘才和相邻的普通列表对得上。
		const markerText = (index: number): string =>
			token.ordered ? `${startNumber + index}. ` : "  ";
		const markerWidth = token.ordered ? `${startNumber + token.items.length - 1}. `.length : 2;
		// 词项列宽整块一起算：列轨的价值就在对齐，逐条判断会锯齿。
		const termColumn =
			this.options.termColumnLists === true ? this.getTermColumnWidth(token, width, markerWidth) : undefined;

		for (let i = 0; i < token.items.length; i++) {
			const item = token.items[i];
			const isLastItem = i === token.items.length - 1;
			if (termColumn !== undefined) {
				lines.push(
					...this.renderTermListItem(item, indent, markerText(i), markerWidth, termColumn, width, styleContext),
				);
				if (token.loose && !isLastItem) lines.push("");
				continue;
			}
			const bullet = token.ordered
				? this.options.preserveOrderedListMarkers
					? (this.getOrderedListMarker(item) ?? `${startNumber + i}. `)
					: `${startNumber + i}. `
				: this.options.preserveOrderedListMarkers
					? (this.getUnorderedListMarker(item) ?? "- ")
					: "- ";
			const taskMarker = item.task ? `[${item.checked ? "x" : " "}] ` : "";
			const marker = bullet + taskMarker;
			const firstPrefix = indent + this.theme.listBullet(marker);
			const continuationPrefix = indent + " ".repeat(visibleWidth(marker));
			const itemWidth = Math.max(1, width - visibleWidth(firstPrefix));
			let renderedAnyLine = false;

			for (const itemToken of item.tokens) {
				if (itemToken.type === "list") {
					lines.push(...this.renderList(itemToken as Tokens.List, depth + 1, width, styleContext));
					renderedAnyLine = true;
					continue;
				}

				const itemLines = this.renderToken(itemToken, itemWidth, undefined, styleContext);
				for (const line of itemLines) {
					for (const wrappedLine of wrapTextWithAnsi(line, itemWidth)) {
						const linePrefix = renderedAnyLine ? continuationPrefix : firstPrefix;
						lines.push(linePrefix + wrappedLine);
						renderedAnyLine = true;
					}
				}
			}

			if (!renderedAnyLine) {
				lines.push(firstPrefix);
			}

			if (token.loose && !isLastItem) {
				lines.push("");
			}
		}

		return lines;
	}

	/**
	 * Get the visible width of the longest word in a string.
	 */
	private getLongestWordWidth(text: string, maxWidth?: number): number {
		const words = text.split(/\s+/).filter((word) => word.length > 0);
		let longest = 0;
		for (const word of words) {
			longest = Math.max(longest, visibleWidth(word));
		}
		if (maxWidth === undefined) {
			return longest;
		}
		return Math.min(longest, maxWidth);
	}

	/**
	 * Wrap a table cell to fit into a column.
	 *
	 * Delegates to wrapTextWithAnsi() so ANSI codes + long tokens are handled
	 * consistently with the rest of the renderer.
	 */
	private wrapCellText(text: string, maxWidth: number, stylePrefix = ""): string[] {
		const lines = wrapTextWithAnsi(text, Math.max(1, maxWidth));
		return lines.map((line, index) => {
			// Reset text styles after each non-final fragment, then restore the surrounding style before padding and borders.
			const styleReset = index < lines.length - 1 ? "\x1b[22;23;24;25;27;28;29;39m" : "";
			return `${line}${styleReset}${stylePrefix}`;
		});
	}

	/**
	 * Render a table with width-aware cell wrapping.
	 * Cells that don't fit are wrapped to multiple lines.
	 */
	private renderTable(
		token: Tokens.Table,
		availableWidth: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
	): string[] {
		const lines: string[] = [];
		const numCols = token.header.length;

		if (numCols === 0) {
			return lines;
		}

		// Calculate border overhead: "│ " + (n-1) * " │ " + " │"
		// = 2 + (n-1) * 3 + 2 = 3n + 1
		const borderOverhead = 3 * numCols + 1;
		const availableForCells = availableWidth - borderOverhead;
		if (availableForCells < numCols) {
			// Too narrow to render a stable table. Fall back to raw markdown.
			const fallbackLines = token.raw ? wrapTextWithAnsi(token.raw, availableWidth) : [];
			if (nextTokenType && nextTokenType !== "space") {
				fallbackLines.push("");
			}
			return fallbackLines;
		}

		const maxUnbrokenWordWidth = 30;

		// Calculate natural column widths (what each column needs without constraints)
		const naturalWidths: number[] = [];
		const minWordWidths: number[] = [];
		// 单元格内联渲染留到这一步,后面输出阶段直接复用:同一份 styleContext 下结果相同,
		// 流式重渲染时省掉一遍对全部表头/单元格的重复渲染。
		const headerTexts = token.header.map((cell) => this.renderInlineTokens(cell.tokens || [], styleContext));
		for (let i = 0; i < numCols; i++) {
			const headerText = headerTexts[i];
			naturalWidths[i] = visibleWidth(headerText);
			minWordWidths[i] = Math.max(1, this.getLongestWordWidth(headerText, maxUnbrokenWordWidth));
		}
		const rowTexts: string[][] = token.rows.map((row) =>
			row.map((cell) => this.renderInlineTokens(cell.tokens || [], styleContext)),
		);
		for (const rowText of rowTexts) {
			for (let i = 0; i < rowText.length; i++) {
				const cellText = rowText[i];
				naturalWidths[i] = Math.max(naturalWidths[i] || 0, visibleWidth(cellText));
				minWordWidths[i] = Math.max(
					minWordWidths[i] || 1,
					this.getLongestWordWidth(cellText, maxUnbrokenWordWidth),
				);
			}
		}

		let minColumnWidths = minWordWidths;
		let minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);

		if (minCellsWidth > availableForCells) {
			minColumnWidths = new Array(numCols).fill(1);
			const remaining = availableForCells - numCols;

			if (remaining > 0) {
				const totalWeight = minWordWidths.reduce((total, width) => total + Math.max(0, width - 1), 0);
				const growth = minWordWidths.map((width) => {
					const weight = Math.max(0, width - 1);
					return totalWeight > 0 ? Math.floor((weight / totalWeight) * remaining) : 0;
				});

				for (let i = 0; i < numCols; i++) {
					minColumnWidths[i] += growth[i] ?? 0;
				}

				const allocated = growth.reduce((total, width) => total + width, 0);
				let leftover = remaining - allocated;
				for (let i = 0; leftover > 0 && i < numCols; i++) {
					minColumnWidths[i]++;
					leftover--;
				}
			}

			minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);
		}

		// Calculate column widths that fit within available width
		const totalNaturalWidth = naturalWidths.reduce((a, b) => a + b, 0) + borderOverhead;
		let columnWidths: number[];

		if (totalNaturalWidth <= availableWidth) {
			// Everything fits naturally
			columnWidths = naturalWidths.map((width, index) => Math.max(width, minColumnWidths[index]));
		} else {
			// Need to shrink columns to fit
			const totalGrowPotential = naturalWidths.reduce((total, width, index) => {
				return total + Math.max(0, width - minColumnWidths[index]);
			}, 0);
			const extraWidth = Math.max(0, availableForCells - minCellsWidth);
			columnWidths = minColumnWidths.map((minWidth, index) => {
				const naturalWidth = naturalWidths[index];
				const minWidthDelta = Math.max(0, naturalWidth - minWidth);
				let grow = 0;
				if (totalGrowPotential > 0) {
					grow = Math.floor((minWidthDelta / totalGrowPotential) * extraWidth);
				}
				return minWidth + grow;
			});

			// Adjust for rounding errors - distribute remaining space
			const allocated = columnWidths.reduce((a, b) => a + b, 0);
			let remaining = availableForCells - allocated;
			while (remaining > 0) {
				let grew = false;
				for (let i = 0; i < numCols && remaining > 0; i++) {
					if (columnWidths[i] < naturalWidths[i]) {
						columnWidths[i]++;
						remaining--;
						grew = true;
					}
				}
				if (!grew) {
					break;
				}
			}
		}

		// Render top border
		const topBorderCells = columnWidths.map((w) => "─".repeat(w));
		lines.push(`┌─${topBorderCells.join("─┬─")}─┐`);

		// Render header with wrapping
		const headerCellLines: string[][] = token.header.map((_, i) => {
			const text = headerTexts[i];
			return this.wrapCellText(text, columnWidths[i], styleContext?.stylePrefix);
		});
		const headerLineCount = Math.max(...headerCellLines.map((c) => c.length));

		for (let lineIdx = 0; lineIdx < headerLineCount; lineIdx++) {
			const rowParts = headerCellLines.map((cellLines, colIdx) => {
				const text = cellLines[lineIdx] || "";
				const padded = text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
				return this.theme.bold(padded);
			});
			lines.push(`│ ${rowParts.join(" │ ")} │`);
		}

		// Render separator
		const separatorCells = columnWidths.map((w) => "─".repeat(w));
		const separatorLine = `├─${separatorCells.join("─┼─")}─┤`;
		lines.push(separatorLine);

		// Render rows with wrapping
		for (let rowIndex = 0; rowIndex < token.rows.length; rowIndex++) {
			const row = token.rows[rowIndex];
			const rowCellLines: string[][] = row.map((_, i) => {
				const text = rowTexts[rowIndex][i];
				return this.wrapCellText(text, columnWidths[i], styleContext?.stylePrefix);
			});
			const rowLineCount = Math.max(...rowCellLines.map((c) => c.length));

			for (let lineIdx = 0; lineIdx < rowLineCount; lineIdx++) {
				const rowParts = rowCellLines.map((cellLines, colIdx) => {
					const text = cellLines[lineIdx] || "";
					return text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
				});
				lines.push(`│ ${rowParts.join(" │ ")} │`);
			}

			if (rowIndex < token.rows.length - 1) {
				lines.push(separatorLine);
			}
		}

		// Render bottom border
		const bottomBorderCells = columnWidths.map((w) => "─".repeat(w));
		lines.push(`└─${bottomBorderCells.join("─┴─")}─┘`);

		if (nextTokenType && nextTokenType !== "space") {
			lines.push(""); // Add spacing after table
		}
		return lines;
	}
}
