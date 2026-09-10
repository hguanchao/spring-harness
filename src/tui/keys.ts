/**
 * 终端按键解析：把 raw stdin 的字节流切成按键事件。
 *
 * 两个必须处理的现实问题：
 * 1. stdin 的 chunk 边界和按键边界无关——`\x1b[` 可能落在上一个 chunk 的尾部，
 *    因此解析器保留「半截序列」等待后续字节，而不是当成未知按键丢掉。
 * 2. 单独按 Esc 只发出 `\x1b`，与序列开头无法区分。解析器不猜：把 `\x1b` 留在
 *    缓冲区，由调用方在短延时后调用 flushPending() 兜底成 Escape。
 */

export type Key =
  | { kind: 'text'; text: string }
  | { kind: 'paste'; text: string }
  | { kind: 'enter' }
  | { kind: 'escape' }
  | { kind: 'tab' }
  | { kind: 'backspace' }
  | { kind: 'delete' }
  | { kind: 'left' }
  | { kind: 'right' }
  | { kind: 'up' }
  | { kind: 'down' }
  | { kind: 'home' }
  | { kind: 'end' }
  | { kind: 'pageup' }
  | { kind: 'pagedown' }
  /** 鼠标滚轮：方向即滚动方向。 */
  | { kind: 'wheel'; direction: 'up' | 'down' }
  /**
   * 已识别但当前不处理的事件（鼠标按键、拖拽移动等）。
   * 必须显式忽略而不是当成 unknown —— unknown 会带着原始文本继续往下走，最终可能被
   * 写进输入行；而这些字节是终端的协议数据，不该出现在用户的输入里。
   */
  | { kind: 'ignore' }
  | { kind: 'ctrl'; key: string }
  | { kind: 'unknown'; raw: string };

/** ESC 起始序列的长度；未收全返回 -1。 */
function escapeLength(buffer: string, start: number): number {
  if (start + 1 >= buffer.length) return -1;
  const next = buffer[start + 1];
  if (next === '[') {
    let i = start + 2;
    while (i < buffer.length && !/[@-~]/.test(buffer[i])) i++;
    return i < buffer.length ? i - start + 1 : -1;
  }
  if (next === 'O') {
    return start + 2 < buffer.length ? 3 : -1;
  }
  return 2;
}

/** CSI 序列（含前导 `[` 与终止字节）→ 按键。 */
function csiKey(sequence: string): Key {
  const final = sequence[sequence.length - 1];
  const body = sequence.slice(1, -1);
  switch (final) {
    case 'A':
      return { kind: 'up' };
    case 'B':
      return { kind: 'down' };
    case 'C':
      return { kind: 'right' };
    case 'D':
      return { kind: 'left' };
    case 'H':
      return { kind: 'home' };
    case 'F':
      return { kind: 'end' };
    case 'Z':
      return { kind: 'tab' };
    case '~': {
      const num = Number(/^\d+/.exec(body)?.[0] ?? '0');
      if (num === 1 || num === 7) return { kind: 'home' };
      if (num === 4 || num === 8) return { kind: 'end' };
      if (num === 3) return { kind: 'delete' };
      if (num === 5) return { kind: 'pageup' };
      if (num === 6) return { kind: 'pagedown' };
      return { kind: 'unknown', raw: `\x1b${sequence}` };
    }
    // SGR 鼠标（?1006h）：`ESC [ < 按键 ; 列 ; 行` + `M`(按下) 或 `m`(释放)。
    case 'M':
    case 'm': {
      const match = /^<(\d+);(\d+);(\d+)$/.exec(body);
      if (!match) return { kind: 'unknown', raw: `\x1b${sequence}` };
      const button = Number(match[1]);
      // 按键码：低两位是键号，bit2..4 是 Shift/Meta/Ctrl，bit5 是「拖动中」。
      // 掩掉修饰位与拖动位之后，64/65 就是滚轮上/下，66/67 是水平滚轮。
      const code = button & ~0b11100;
      if (final === 'M' && (code === 64 || code === 65)) {
        return { kind: 'wheel', direction: code === 64 ? 'up' : 'down' };
      }
      // 左/中/右键与拖拽：本轮不做鼠标交互，显式忽略。
      return { kind: 'ignore' };
    }
    default:
      return { kind: 'unknown', raw: `\x1b${sequence}` };
  }
}

/** SS3 序列（`\x1bO` 开头，部分终端用它发方向键/home/end）。 */
function ss3Key(sequence: string): Key {
  switch (sequence[sequence.length - 1]) {
    case 'A':
      return { kind: 'up' };
    case 'B':
      return { kind: 'down' };
    case 'C':
      return { kind: 'right' };
    case 'D':
      return { kind: 'left' };
    case 'H':
      return { kind: 'home' };
    case 'F':
      return { kind: 'end' };
    default:
      return { kind: 'unknown', raw: `\x1b${sequence}` };
  }
}

/** 有状态解析器：一次 feed 一段 chunk，返回能确定的按键，半截序列留给下次。 */
export class KeyParser {
  private buffer = '';
  private pasting = false;
  private pasteText = '';
  /** 老式 X10 鼠标报文还需吞掉的字节数（见 push 里的 `\x1b[M` 分支）。 */
  private x10Remaining = 0;

  push(chunk: string): Key[] {
    this.buffer += chunk;
    const keys: Key[] = [];
    while (this.buffer.length > 0) {
      if (this.x10Remaining > 0) {
        const take = Math.min(this.x10Remaining, this.buffer.length);
        this.buffer = this.buffer.slice(take);
        this.x10Remaining -= take;
        continue;
      }
      if (this.pasting) {
        const end = this.buffer.indexOf('\x1b[201~');
        if (end === -1) {
          this.pasteText += this.buffer;
          this.buffer = '';
          break;
        }
        this.pasteText += this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + '\x1b[201~'.length);
        this.pasting = false;
        keys.push({ kind: 'paste', text: normalizePaste(this.pasteText) });
        this.pasteText = '';
        continue;
      }

      const cp = this.buffer.codePointAt(0)!;
      if (cp === 0x1b) {
        const length = escapeLength(this.buffer, 0);
        if (length === -1) break; // 半截序列：等下一个 chunk
        const sequence = this.buffer.slice(0, length);
        this.buffer = this.buffer.slice(length);
        const body = sequence.slice(1);
        if (body === '[200~') {
          this.pasting = true;
          this.pasteText = '';
          continue;
        }
        // 老式 X10 鼠标报文：`ESC [ M` 之后紧跟 3 个**原始字节**（不含 `<` 的终端
        // 会这么发）。这 3 个字节多半落在可打印区，若不吞掉就会被当成用户输入写进
        // 输入行，表现为「一动鼠标就冒出一串乱码」。
        if (body === '[M') {
          this.x10Remaining = 3;
          continue;
        }
        keys.push(body.startsWith('[') ? csiKey(body) : body.startsWith('O') ? ss3Key(body) : { kind: 'escape' });
        continue;
      }

      const ch = String.fromCodePoint(cp);
      this.buffer = this.buffer.slice(ch.length);
      if (cp === 0x0d || cp === 0x0a) keys.push({ kind: 'enter' });
      else if (cp === 0x09) keys.push({ kind: 'tab' });
      else if (cp === 0x7f || cp === 0x08) keys.push({ kind: 'backspace' });
      else if (cp >= 1 && cp <= 26) keys.push({ kind: 'ctrl', key: String.fromCharCode(cp + 96) });
      else if (cp < 32) keys.push({ kind: 'unknown', raw: ch });
      else keys.push({ kind: 'text', text: ch });
    }
    return keys;
  }

  /** 缓冲区里可能还留着 `\x1b`（用户按了 Esc 而后面没有序列）。延时后兜底发出。 */
  flushPending(): Key[] {
    if (this.pasting) {
      const text = this.pasteText;
      this.pasting = false;
      this.pasteText = '';
      return text === '' ? [] : [{ kind: 'paste', text: normalizePaste(text) }];
    }
    if (this.buffer === '') return [];
    const raw = this.buffer;
    this.buffer = '';
    return raw === '\x1b' ? [{ kind: 'escape' }] : [{ kind: 'unknown', raw }];
  }

  get pending(): boolean {
    return this.buffer !== '' || this.pasting;
  }
}

/** 粘贴文本压成单行可插入的形态：换行与制表转空格，避免误触发提交。 */
function normalizePaste(text: string): string {
  return text.replace(/\r\n?|\n/g, ' ').replace(/\t/g, '  ');
}
