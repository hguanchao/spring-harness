/**
 * 阅读面：主色（OpenCode 紫）、正文 #c6c6c6、中性灰；行内码另用一档蓝。
 * 行内码整段蓝、不加词法；无语言围栏整块中性灰，不猜。
 *
 * 紫/蓝/红/黄/绿取 OpenCode 默认暗色主题
 * https://github.com/anomalyco/opencode packages/tui/src/theme/assets/opencode.json
 */

/** OpenCode darkAccent。标题、列表、进行中工具前缀。 */
const PRIMARY = '#9d7cd8';
const TEXT = '#c6c6c6';
const MUTED = '#6c6c6c';
/** GrokNight 画布底。纯黑会把 #c6c6c6 衬得过亮。 */
const BG = '#141414';
const CHROME = '#242424';
/** OpenCode darkSecondary。行内码整段用，不做词法分色。 */
const SYNTAX = '#5c9cf5';

export const PALETTE = {
  bg: BG,
  primary: PRIMARY,
  accent: PRIMARY,
  border: MUTED,
  borderMuted: MUTED,
  success: '#7fd88f',
  error: '#e06c75',
  warning: '#f5a742',
  muted: MUTED,
  dim: '#808080',
  text: TEXT,
  thinkingText: PRIMARY,

  selectedBg: CHROME,
  scrollbarTrack: MUTED,
  scrollbarThumb: CHROME,
  userMessageBg: CHROME,
  userMessageText: TEXT,
  toolPendingBg: MUTED,
  toolTitle: MUTED,
  toolOutput: MUTED,

  mdText: TEXT,
  mdH1: PRIMARY,
  mdH2: PRIMARY,
  mdH3: PRIMARY,
  // 标题全档走品牌紫：h4-6 曾是正文白，夹在 h1-3 之间深浅不一。
  mdH4: PRIMARY,
  mdH5: PRIMARY,
  mdH6: PRIMARY,
  mdHeading: PRIMARY,
  mdLink: TEXT,
  mdLinkUrl: MUTED,
  mdCode: SYNTAX,
  mdCodeBlock: MUTED,
  mdCodeBlockBorder: MUTED,
  mdQuote: MUTED,
  mdQuoteBorder: MUTED,
  mdHr: MUTED,
  // 列表符号与有序序号同用一色：紫，跟标题同一套强调系。
  mdListBullet: PRIMARY,

  syntaxComment: MUTED,
  syntaxKeyword: SYNTAX,
  syntaxFunction: SYNTAX,
  syntaxString: SYNTAX,
  syntaxAnnotation: SYNTAX,
} as const;

export type ThemeColor = keyof typeof PALETTE;
