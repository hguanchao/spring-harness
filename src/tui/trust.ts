/**
 * 启动前的工作区信任面板。
 *
 * 信任发生在 sandbox、session 和 Agent runtime 创建之前，因此不能复用运行中的
 * TuiApp 审批浮层；这里仅借用同一套终端与按键协议，完成一次性的启动闸门确认。
 */

import { colorDepth, colorEnabled, createStyler, displayWidth, truncate, wrap, type Styler } from './ansi.js';
import { renderDialog, type DialogChoice, type DialogLine } from './dialog.js';
import { KeyParser } from './keys.js';
import { InputQueue, Terminal } from './terminal.js';

type TrustChoice = 'trust' | 'deny';

interface TrustPromptOptions {
  width: number;
  height: number;
  workspaceRoot: string;
  choice: TrustChoice;
  styler: Styler;
}

const MAX_BOX_WIDTH = 78;

/**
 * 渲染启动前信任面板。纯函数便于在没有真实 TTY 的情况下检查窄窗口和选中态，
 * 同时把安全说明与选项放进同一个视觉容器，避免用户只看到一个裸的 y/N 提示。
 */
export function renderTrustPrompt(options: TrustPromptOptions): string[] {
  const width = Math.max(20, Math.floor(options.width));
  const height = Math.max(8, Math.floor(options.height));
  const boxWidth = Math.min(MAX_BOX_WIDTH, Math.max(20, width - 4));
  const innerWidth = boxWidth - 2;
  const compact = height < 14 || width < 42;
  const pathLines = wrap(options.workspaceRoot, Math.max(8, innerWidth));
  const visiblePath = pathLines.slice(0, compact ? 1 : 2);
  if (visiblePath.length === 0) visiblePath.push('（未知目录）');
  if (pathLines.length > visiblePath.length) {
    const last = visiblePath.length - 1;
    visiblePath[last] = truncate(visiblePath[last], Math.max(4, innerWidth - 3), '...');
  }
  const compactHint = width < 42 ? '上下 | Enter | y/n' : '上下键选择 | Enter确认 | y信任 | n/Esc拒绝';

  const lines: DialogLine[] = compact
    ? [
        { text: truncate(`工作区：${visiblePath[0]}`, innerWidth, ''), paint: options.styler.cyan },
      ]
    : [
        { text: '请确认是否允许 sph 在此目录中工作。', paint: options.styler.bold },
        { text: '' },
        { text: '工作区', paint: options.styler.dim },
        ...visiblePath.map((line) => ({ text: line, paint: options.styler.cyan })),
        { text: '' },
        { text: '该目录中的 AGENTS.md、skills 和工具会进入模型上下文，', paint: options.styler.dim },
        { text: '工具也可能读取、修改或执行其中的内容。', paint: options.styler.dim },
        { text: '' },
      ];

  const choices: DialogChoice[] = [
    { label: '信任此目录并继续', selected: options.choice === 'trust' },
    { label: '拒绝并退出', selected: options.choice === 'deny' },
  ];
  const frameRows = renderDialog({
    width: boxWidth,
    title: '工作区尚未信任',
    marker: '[!]',
    titlePaint: options.styler.yellow,
    lines,
    choices,
    footer: compactHint,
    styler: options.styler,
  });
  const top = Math.max(0, Math.floor((height - frameRows.length) / 2));
  const output = Array.from({ length: height }, () => '');
  for (let index = 0; index < frameRows.length && top + index < height; index++) {
    const line = frameRows[index];
    const left = Math.max(0, Math.floor((width - displayWidth(line)) / 2));
    output[top + index] = `${' '.repeat(left)}${line}`;
  }
  return output;
}

/**
 * 进入一次性替代屏幕并等待信任选择。拒绝和 Ctrl+C 都返回 false，调用方统一 fail-closed。
 */
export async function confirmWorkspaceTrust(workspaceRoot: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;

  const input = new InputQueue();
  const parser = new KeyParser();
  const styler = createStyler(colorEnabled(), colorDepth());
  let choice: TrustChoice = 'trust';
  let escTimer: NodeJS.Timeout | undefined;

  const terminal = new Terminal((text) => {
    input.push(parser.push(text));
    if (escTimer) clearTimeout(escTimer);
    if (parser.pending) {
      escTimer = setTimeout(() => {
        escTimer = undefined;
        input.push(parser.flushPending());
      }, 40);
    }
  }, false);
  const render = (): void => {
    const size = terminal.size();
    terminal.paint(renderTrustPrompt({ ...size, workspaceRoot, choice, styler }), null);
  };

  try {
    terminal.enter(render);
    render();
    for (;;) {
      const key = await input.next();
      if (!key) return false;
      if (key.kind === 'up' || key.kind === 'down') {
        choice = choice === 'trust' ? 'deny' : 'trust';
        render();
        continue;
      }
      if (key.kind === 'enter') return choice === 'trust';
      if (key.kind === 'escape' || (key.kind === 'ctrl' && (key.key === 'c' || key.key === 'd'))) return false;
      if (key.kind !== 'text') continue;
      const text = key.text.toLowerCase();
      if (text === 'y') return true;
      if (text === 'n') return false;
    }
  } finally {
    if (escTimer) clearTimeout(escTimer);
    terminal.restore();
  }
}
