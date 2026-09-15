/**
 * 阅读面：主色（Material Deep Purple 300）、正文 #c8c8c8、中性灰；带语言围栏的语法高亮另用一档蓝。
 * 行内码整段蓝、不加词法；无语言围栏整块中性灰，不猜。
 */

/**
 * Material Design Deep Purple 300。
 * 500 档 `#9C27B0` 是引用最多的「标准紫」，但比正文 `#c8c8c8` 还暗，标题会发闷；
 * 300 是暗色界面用的浅一档，是紫、不刺眼。
 */
const PRIMARY = '#9575cd';
const TEXT = '#c8c8c8';
const MUTED = '#6c6c6c';
/** GrokNight 画布底。纯黑会把 #c8c8c8 衬得过亮。 */
const BG = '#141414';
const CHROME = '#242424';
/**
 * Material Design Blue 300。
 * 500 档 `#2196F3` 是引用最多的「标准蓝」，在 #141414 上偏闷；
 * 300 与主色同一档，带语言围栏用，不跟 TokyoNight `#7aa2f7` 那种亮蓝。
 */
const SYNTAX = '#64b5f6';

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
  mdH4: TEXT,
  mdH5: TEXT,
  mdH6: TEXT,
  mdHeading: PRIMARY,
  mdLink: TEXT,
  mdLinkUrl: MUTED,
  mdCode: SYNTAX,
  mdCodeBlock: MUTED,
  mdCodeBlockBorder: MUTED,
  mdQuote: MUTED,
  mdQuoteBorder: MUTED,
  mdHr: MUTED,
  mdListBullet: MUTED,

  syntaxComment: MUTED,
  syntaxKeyword: SYNTAX,
  syntaxFunction: SYNTAX,
  syntaxString: SYNTAX,
  syntaxAnnotation: SYNTAX,
} as const;

export type ThemeColor = keyof typeof PALETTE;
