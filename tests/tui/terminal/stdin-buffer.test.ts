import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { StdinBuffer } from '@/tui/terminal/stdin-buffer.js';

function collect(buffer: StdinBuffer): { data: string[]; paste: string[] } {
  const data: string[] = [];
  const paste: string[] = [];
  buffer.on('data', (chunk) => data.push(chunk));
  buffer.on('paste', (chunk) => paste.push(chunk));
  return { data, paste };
}

describe('StdinBuffer', () => {
  it('完整 CSI 一次发出', () => {
    const buffer = new StdinBuffer();
    const out = collect(buffer);
    buffer.process('\x1b[A');
    assert.deepEqual(out.data, ['\x1b[A']);
  });

  it('半截 CSI 攒到完整再发', () => {
    const buffer = new StdinBuffer();
    const out = collect(buffer);
    buffer.process('\x1b[');
    assert.deepEqual(out.data, []);
    buffer.process('A');
    assert.deepEqual(out.data, ['\x1b[A']);
  });

  it('SGR 鼠标分片后拼成一条', () => {
    const buffer = new StdinBuffer();
    const out = collect(buffer);
    buffer.process('\x1b[<35');
    buffer.process(';20;5m');
    assert.deepEqual(out.data, ['\x1b[<35;20;5m']);
  });

  it('拼在一起的滚轮序列要拆成几条', () => {
    // 滚轮快速滚动时终端会把几格攒在一个 chunk 里发过来。上层按「一条输入 = 一个事件」处理
    // （parseWheelEvent 整串锚定匹配），整串发上去等于把这几格一起吞掉——滚轮看着就是滚不动。
    const buffer = new StdinBuffer();
    const out = collect(buffer);
    buffer.process('\x1b[<65;20;5M\x1b[<65;20;5M\x1b[<64;20;5M');
    assert.deepEqual(out.data, ['\x1b[<65;20;5M', '\x1b[<65;20;5M', '\x1b[<64;20;5M']);
  });

  it('括号粘贴走 paste 事件，内容不拆成按键', () => {
    const buffer = new StdinBuffer();
    const out = collect(buffer);
    buffer.process('\x1b[200~hello\rworld\x1b[201~');
    assert.deepEqual(out.paste, ['hello\rworld']);
    assert.deepEqual(out.data, []);
  });

  it('ESC ESC[ 拆成单独 Escape 再跟 CSI，避免把 [ 当普通字打出去', () => {
    const buffer = new StdinBuffer();
    const out = collect(buffer);
    buffer.process('\x1b\x1b[27u');
    assert.deepEqual(out.data, ['\x1b', '\x1b[27u']);
  });

  it('destroy 丢掉半截序列', () => {
    const buffer = new StdinBuffer();
    const out = collect(buffer);
    buffer.process('\x1b[');
    buffer.destroy();
    buffer.process('A');
    assert.deepEqual(out.data, ['A']);
  });
});
