/**
 * 终端会话层：raw mode、全屏整帧绘制、恢复现场、按键队列。
 *
 * 界面采用**替代屏幕缓冲区（alt screen）**：进入时申请一整块全新空白屏幕（vim / htop
 * 的做法），退出时终端自动把进入前的画面原样还回去。因此启动后看不到任何历史命令、
 * 旧输出之类的干扰信息，退出后也不会污染用户的终端。
 *
 * 绘制采用**整帧覆盖**而不是「补丁式重绘」：每一帧都从左上角开始，逐行清行再写内容，
 * 最后把光标绝对定位到目标位置。这样做的代价是每帧都要重写整个可见区域（现代终端下
 * 一两千字节，可以忽略），换来的是**不存在任何状态记账**——不记录「上一帧占了几行」
 * 「光标落在第几行」。窗口缩放时终端重排的只是屏幕上那一帧旧像素，下一次整帧覆盖会把
 * 它整个抹掉，因此不会出现「重排后记账失真 → 叠加成几十行残影」那类故障。
 */

import { StringDecoder } from 'node:string_decoder';
import type { Key } from './keys.js';
import { ansi, clipLine } from './ansi.js';

export class InputQueue {
  private keys: Key[] = [];
  private waiter: ((key: Key | null) => void) | null = null;
  private closed = false;

  push(keys: readonly Key[]): void {
    for (const key of keys) {
      if (this.waiter) {
        const resolve = this.waiter;
        this.waiter = null;
        resolve(key);
      } else {
        this.keys.push(key);
      }
    }
  }

  next(): Promise<Key | null> {
    const queued = this.keys.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  /** 关闭：唤醒等待中的读取方并让它拿到 null，主循环据此退出。 */
  close(): void {
    this.closed = true;
    const resolve = this.waiter;
    this.waiter = null;
    resolve?.(null);
  }
}

export interface TerminalSize {
  width: number;
  height: number;
}

/**
 * 进入全屏现场要发的序列。抽成纯函数是为了可断言：鼠标模式与 bracketed paste 都
 * **必须成对开关**，漏掉一半会让用户回到 shell 后拖选失灵或粘贴异常。
 */
export function enterSequences(mouse: boolean): string {
  return ansi.altScreenOn + ansi.bracketedPasteOn + (mouse ? ansi.mouseOn : '') + ansi.hideCursor;
}

/** 退出时恢复现场的序列（与进入严格对应，多余的模式一律不关）。 */
export function exitSequences(mouse: boolean): string {
  return ansi.showCursor + (mouse ? ansi.mouseOff : '') + ansi.bracketedPasteOff + ansi.altScreenOff;
}

export class Terminal {
  private entered = false;
  private readonly decoder = new StringDecoder('utf8');
  private resizeHandler: (() => void) | null = null;

  constructor(
    private readonly onInput: (text: string) => void,
    /**
     * 是否启用鼠标滚轮。开着才能用滚轮翻历史，代价是终端不再自己处理鼠标拖选
     * （Windows Terminal 下要按住 Shift 才是原生选择），所以允许关掉。
     */
    private readonly mouse: boolean = true,
  ) {}

  get active(): boolean {
    return this.entered;
  }

  size(): TerminalSize {
    const columns = process.stdout.columns;
    const rows = process.stdout.rows;
    return {
      width: Math.max(20, typeof columns === 'number' && columns > 0 ? columns : 80),
      height: Math.max(8, typeof rows === 'number' && rows > 0 ? rows : 24),
    };
  }

  enter(onResize: () => void): void {
    if (this.entered) return;
    this.entered = true;
    const stdin = process.stdin;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', this.handleData);
    // Windows 不发 SIGWINCH，但 TTY 流会发 'resize'，两端共用这一条路径。
    this.resizeHandler = onResize;
    process.stdout.on('resize', onResize);
    // 先切到替代屏幕（含清屏回左上），再开 bracketed paste 与鼠标、藏光标。
    process.stdout.write(enterSequences(this.mouse));
  }

  private readonly handleData = (chunk: Buffer | string): void => {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    if (text !== '') this.onInput(text);
  };

  /**
   * 把整帧内容覆盖到屏幕上。
   *
   * lines 按屏幕行给出（长度应等于终端高度，不足的部分会被清空）；超长行由调用方保证
   * 已经按宽度折过或截断——写入到最后一列会触发终端的自动换行，让整帧错位一行。
   */
  paint(lines: readonly string[], cursor: { row: number; col: number } | null): void {
    if (!this.entered) return;
    const { width, height } = this.size();
    const limit = Math.max(1, width - 1);
    let out = ansi.syncOn + ansi.home;
    for (let row = 0; row < height; row++) {
      out += ansi.clearLine + clipLine(lines[row] ?? '', limit);
      if (row < height - 1) out += ansi.newline;
    }
    out += cursor ? ansi.position(cursor.row, cursor.col) + ansi.showCursor : ansi.hideCursor;
    out += ansi.syncOff;
    process.stdout.write(out);
  }

  /**
   * 恢复现场。必须能在任何退出路径（正常退出、Ctrl+C、未捕获异常）上安全重复调用。
   *
   * 顺序有讲究：先恢复光标可见性，再关掉鼠标与 bracketed paste，最后才切回主屏幕
   * —— 主屏幕里用户原本的光标状态本来就该是可见的，而 alt screen 里的隐藏状态会随
   * 缓冲区一起被丢弃。鼠标模式**必须显式关闭**：它是终端侧的状态，不随 alt screen
   * 一起丢弃，漏关会让用户回到 shell 后仍无法正常拖选。
   */
  restore(): void {
    if (!this.entered) return;
    this.entered = false;
    process.stdout.write(exitSequences(this.mouse));
    process.stdin.off('data', this.handleData);
    if (this.resizeHandler) {
      process.stdout.off('resize', this.resizeHandler);
      this.resizeHandler = null;
    }
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}
