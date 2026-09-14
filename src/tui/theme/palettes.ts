/**
 * 内置色板。背景交给终端。
 *
 * UI 四档 + 代码第五档（IntelliJ Darcula，只作用于围栏/行内代码）：
 * - primary 紫：品牌、进行中、标题、链接、列表点
 * - text 浅灰：助手正文、用户气泡字
 * - muted 中性灰：弱化、工具行、斜体、引用、滚动条
 * - error / warning / success：失败 / 水位 / 成功通知
 * - 代码默认字 #a9b7c6，关键字橙、字符串绿、方法金、数字蓝
 */

const GRAY = '#808080';
const PURPLE = '#9d7cd8';
const BODY = '#cccccc';

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
  mdCode: '#a9b7c6',
  mdCodeBlock: '#a9b7c6',
  mdCodeBlockBorder: GRAY,
  mdQuote: GRAY,
  mdQuoteBorder: GRAY,
  mdHr: GRAY,
  mdListBullet: PURPLE,

  syntaxComment: GRAY,
  syntaxKeyword: '#cc7832',
  syntaxFunction: '#ffc66d',
  syntaxVariable: '#a9b7c6',
  syntaxString: '#6a8759',
  syntaxNumber: '#6897bb',
  syntaxType: '#a9b7c6',
  syntaxOperator: '#a9b7c6',
  syntaxPunctuation: '#a9b7c6',
  syntaxProperty: '#9876aa',
  syntaxAnnotation: '#bbb529',
} as const;

export type ThemeColor = keyof typeof PALETTE;
