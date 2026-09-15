/**
 * 内置色板。背景交给终端。
 *
 * UI 四档 + 代码第五档（IntelliJ Darcula，只作用于围栏/行内代码）：
 * - primary 紫：品牌、进行中、标题、链接、列表点
 * - text 浅灰：助手正文、用户气泡字
 * - muted 中性灰：弱化、工具行、斜体、引用、滚动条
 * - error / warning / success：失败 / 水位 / 成功通知
 * - 代码档见下方 CODE_* 常量：方法/函数 #56a8f5，注解 #ffc66d，关键字 #cc7832，
 *   字符串 #6a8759，注释 #808080 斜体；中性档按渲染面分两档（见 CODE_* 注释）。
 */

const GRAY = '#808080';
const PURPLE = '#9d7cd8';
const BODY = '#cccccc';

/**
 * 代码档（IntelliJ Darcula 角色划分，方法色为自定义）。
 *
 * 中性档按**渲染面**分两档，而不是按 scope 细分：
 * - 围栏代码块正文 #808080 —— 整块比助手正文暗一档，读起来是「一段引用的原始输出」，
 *   围栏 ``` 与之同色，块内不再出现灰白相间。
 * - 行内代码 #cccccc —— 行内码夹在正文中间，压到 #808080 就和正文糊在一起了。
 *
 * highlight.js 的 default / variable / type / property / number / operator / punctuation
 * 在真实代码里大面积交错，各自留一点色差只会让代码块看起来脏；它们各自归到所属面的
 * 中性档，只有方法/函数、注解、关键字、字符串几档才带色相。
 */
const CODE_BLOCK_PLAIN = GRAY;
const CODE_INLINE_PLAIN = '#cccccc';
/** 方法 / 函数（含它的括号）。 */
const CODE_METHOD = '#56a8f5';
const CODE_ANNOTATION = '#ffc66d';
const CODE_KEYWORD = '#cc7832';
const CODE_STRING = '#6a8759';
const CODE_COMMENT = GRAY;

export const PALETTE = {
  primary: PURPLE,
  accent: PURPLE,
  border: GRAY,
  borderMuted: GRAY,
  success: '#7fd88f',
  error: '#e06c75',
  warning: '#f5a742',
  muted: GRAY,
  dim: GRAY,
  text: BODY,
  thinkingText: GRAY,

  selectedBg: '#2c2c2c',
  scrollbarTrack: GRAY,
  scrollbarThumb: GRAY,
  userMessageBg: '#2c2c2c',
  userMessageText: BODY,
  toolPendingBg: GRAY,
  toolTitle: GRAY,
  toolOutput: GRAY,

  mdText: BODY,
  mdH1: PURPLE,
  mdH2: PURPLE,
  mdH3: PURPLE,
  mdH4: PURPLE,
  mdH5: PURPLE,
  mdH6: PURPLE,
  mdHeading: PURPLE,
  mdLink: PURPLE,
  mdLinkUrl: GRAY,
  /** 行内代码（codespan）的中性档；语法色由 syntax* 提供。 */
  mdCode: CODE_INLINE_PLAIN,
  /** 围栏代码块正文的中性档；所有围栏（含带语言的）整块走它。 */
  mdCodeBlock: CODE_BLOCK_PLAIN,
  /** 围栏 ``` 本身：与代码正文同色，且不叠斜体。 */
  mdCodeBlockBorder: GRAY,
  mdQuote: GRAY,
  mdQuoteBorder: GRAY,
  mdHr: GRAY,
  mdListBullet: PURPLE,

  syntaxComment: CODE_COMMENT,
  syntaxKeyword: CODE_KEYWORD,
  syntaxFunction: CODE_METHOD,
  syntaxString: CODE_STRING,
  syntaxAnnotation: CODE_ANNOTATION,
} as const;

export type ThemeColor = keyof typeof PALETTE;

