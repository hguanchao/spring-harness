/**
 * TUI 弹窗的共同排版。
 *
 * 弹窗与输入区共享同一条视觉语法：只用上下分隔线建立边界，内容留出两列呼吸空间，
 * 选择项用整行反显表达当前焦点。这样不同弹窗不会各自发明一套框线和选中符号。
 */

import { displayWidth, pad, truncate, type Styler } from './ansi.js';

export interface DialogLine {
  text: string;
  paint?: (text: string) => string;
  /** 默认 2 列；状态面板这类已经包含标签列的内容可设为 0。 */
  indent?: number;
}

export interface DialogChoice {
  label: string;
  hint?: string;
  selected: boolean;
  /** 有提示文本时，标签固定到该列宽，便于选项纵向扫描。 */
  labelWidth?: number;
}

export interface DialogOptions {
  width: number;
  title: string;
  marker?: string;
  titlePaint?: (text: string) => string;
  lines?: readonly DialogLine[];
  choices?: readonly DialogChoice[];
  footer?: string;
  styler: Styler;
}

/** 渲染统一的上下边框弹窗；返回值按终端行排列，调用方无需再处理 ANSI 宽度。 */
export function renderDialog(options: DialogOptions): string[] {
  const width = Math.max(1, Math.floor(options.width));
  const out = [rule(width, options.styler)];
  const title = options.marker === undefined ? options.title : `${options.marker} ${options.title}`;
  out.push(renderLine(title, width, options.titlePaint ?? options.styler.bold));

  for (const line of options.lines ?? []) {
    out.push(renderDialogLine(line, width));
  }
  for (const choice of options.choices ?? []) {
    out.push(renderChoice(choice, width, options.styler));
  }
  if (options.footer !== undefined) {
    out.push(renderLine(`  ${options.footer}`, width, options.styler.dim));
  }

  out.push(rule(width, options.styler));
  return out;
}

function rule(width: number, styler: Styler): string {
  return styler.dim('─'.repeat(width));
}

function renderDialogLine(line: DialogLine, width: number): string {
  const indent = Math.max(0, Math.floor(line.indent ?? 2));
  return renderLine(`${' '.repeat(indent)}${line.text}`, width, line.paint);
}

function renderLine(text: string, width: number, paint?: (text: string) => string): string {
  const fitted = pad(truncate(text, width, ''), width);
  return paint ? paint(fitted) : fitted;
}

/**
 * 标签列与提示列之间的固定间隔。
 *
 * 不能依赖 pad 的尾随空格：标签显示宽度正好等于 labelWidth 时 pad 是空操作（不补一个空格），
 * 提示会直接贴到标签上——同一个列表里就出现「有的行有间隔、有的行没有」，提示列整体错开。
 * 所以间隔必须显式补，而且调用方算标签列宽时也要把它算进去。
 */
export const CHOICE_GAP = 2;

function renderChoice(choice: DialogChoice, width: number, styler: Styler): string {
  const label = choice.labelWidth === undefined
    ? `  ${choice.label}`
    : `  ${pad(choice.label, choice.labelWidth)}`;
  const hint = choice.hint ?? '';
  const gap = hint === '' ? '' : ' '.repeat(CHOICE_GAP);
  const plain = truncate(`${label}${gap}${hint}`, width, '');
  if (choice.selected) return styler.inverse(pad(plain, width));

  if (hint === '') return renderLine(plain, width);
  const headWidth = Math.min(width, displayWidth(label) + CHOICE_GAP);
  const visibleHint = truncate(hint, Math.max(0, width - headWidth), '');
  return renderLine(`${label}${gap}${styler.dim(visibleHint)}`, width);
}
