/**
 * 终端会话层：raw mode、活动区重绘、恢复现场、按键队列。
 *
 * 「活动区」是屏幕底部那块会重绘的区域（浮层 + 输入行 + 提示 + 状态行）。它之上的内容
 * 是已提交的滚动区，由终端自身管理滚动与回看，因此这里只做两件事：
 *   clearLive() 把活动区抹掉让出光标，写完滚动内容后 drawLive() 再画回来。
 *
 * 重绘靠「上移 cursorRow 行 + 清到屏幕末尾」实现，所以必须精确跟踪终端光标当前落在
 * 活动区的第几行——不跟踪就会在光标不在最后一行时上移过头，把已提交内容吃掉。
 */

import { StringDecoder } from 'node:string_decoder';
import type { Key } from './keys.js';
import { ansi } from './ansi.js';

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

export class Terminal {
  private entered = false;
  private liveRows = 0;
  private cursorRow = 0;
  private readonly decoder = new StringDecoder('utf8');
  private resizeHandler: (() => void) | null = null;

  constructor(private readonly onInput: (text: string) => void) {}

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
    process.stdout.write(ansi.bracketedPasteOn + ansi.hideCursor);
  }

  private readonly handleData = (chunk: Buffer | string): void => {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    if (text !== '') this.onInput(text);
  };

  /** 恢复现场。必须能在任何退出路径（正常退出、Ctrl+C、未捕获异常）上安全重复调用。 */
  restore(): void {
    if (!this.entered) return;
    this.entered = false;
    this.clearLive();
    process.stdout.write(ansi.showCursor + ansi.bracketedPasteOff);
    process.stdin.off('data', this.handleData);
    if (this.resizeHandler) {
      process.stdout.off('resize', this.resizeHandler);
      this.resizeHandler = null;
    }
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  /** 抹掉活动区，把光标交给调用方（用于向滚动区写内容）。 */
  clearLive(): void {
    if (this.liveRows === 0) return;
    process.stdout.write(`\r${ansi.up(this.cursorRow)}${ansi.eraseToEnd}`);
    this.liveRows = 0;
    this.cursorRow = 0;
  }

  /** 重画活动区，并把终端光标放到指定位置（null 表示隐藏光标）。 */
  drawLive(lines: readonly string[], cursor: { row: number; col: number } | null): void {
    if (!this.entered || lines.length === 0) return;
    let out = '';
    if (this.liveRows > 0) out += `\r${ansi.up(this.cursorRow)}${ansi.eraseToEnd}`;
    out += lines.join('\n');
    this.liveRows = lines.length;
    this.cursorRow = cursor ? cursor.row : lines.length - 1;
    if (cursor) {
      out += `\r${ansi.up(lines.length - 1 - cursor.row)}${ansi.column(cursor.col)}${ansi.showCursor}`;
    } else {
      out += ansi.hideCursor;
    }
    process.stdout.write(out);
  }

  /** 往滚动区直接写原始文本（调用方负责先 clearLive / 后 drawLive）。 */
  write(text: string): void {
    process.stdout.write(text);
  }

  clearScreen(): void {
    process.stdout.write('\x1b[2J\x1b[H');
    this.liveRows = 0;
    this.cursorRow = 0;
  }

  /**
   * 外部原因（终端重排、清屏）导致活动区的行数记账失效时调用：
   * 只重置记账，不发送擦除指令——此时按旧行数上移可能吃掉已提交内容。
   */
  resetLive(): void {
    this.liveRows = 0;
    this.cursorRow = 0;
  }
}
