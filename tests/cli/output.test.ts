import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createJsonOutput, createTextOutput } from '../../src/cli/output.js';

/** 临时接管 stdout，收集这段回调里写出的内容。 */
function captureStdout(run: () => void): string {
  const original = process.stdout.write;
  let out = '';
  process.stdout.write = ((chunk: unknown) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    run();
  } finally {
    process.stdout.write = original;
  }
  return out;
}

describe('createJsonOutput', () => {
  it('每个事件一行 JSON，最后补一行 result 汇总', () => {
    const output = createJsonOutput({ sessionId: 's1' });
    const out = captureStdout(() => {
      output.listener({ type: 'thinking_start', id: 't1' });
      output.listener({ type: 'text', text: '你好' });
      output.listener({ type: 'text', text: '，世界' });
      output.listener({ type: 'usage', promptTokens: 10, completionTokens: 2, cachedTokens: 4 });
      output.listener({ type: 'tool_start', name: 'read', id: 'c1', args: { path: 'a' } });
      process.stdout.write(output.finalLine());
    });

    const lines = out.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(lines.length, 6);
    assert.equal(lines[0]?.type, 'thinking_start');
    assert.equal(lines[3]?.type, 'usage');
    assert.equal(lines[4]?.type, 'tool_start');

    const result = lines[5] as { type: string; sessionId: string; text: string; usage: Record<string, number> };
    assert.equal(result.type, 'result');
    assert.equal(result.sessionId, 's1');
    assert.equal(result.text, '你好，世界', '增量由消费端拼接太麻烦，result 里给全量');
    assert.deepEqual(result.usage, { promptTokens: 10, completionTokens: 2, cachedTokens: 4 });
  });

  it('多次 usage 累加，缺失的 cachedTokens 按 0 计', () => {
    const output = createJsonOutput({ sessionId: 's1' });
    const out = captureStdout(() => {
      output.listener({ type: 'usage', promptTokens: 3, completionTokens: 1 });
      output.listener({ type: 'usage', promptTokens: 4, completionTokens: 2, cachedTokens: 5 });
      process.stdout.write(output.finalLine());
    });
    const result = JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as { usage: Record<string, number> };
    assert.deepEqual(result.usage, { promptTokens: 7, completionTokens: 3, cachedTokens: 5 });
  });

  it('正文里的换行被转义，一个事件不会裂成两行', () => {
    const output = createJsonOutput({ sessionId: 's1' });
    const out = captureStdout(() => output.listener({ type: 'text', text: 'a\nb' }));
    assert.equal(out.split('\n').filter((line) => line !== '').length, 1);
  });

  it('subagent_event 这类嵌套事件也照原样输出', () => {
    const output = createJsonOutput({ sessionId: 's1' });
    const out = captureStdout(() => output.listener({ type: 'subagent_event', id: 'sub-1', event: { type: 'text', text: 'x' } }));
    const row = JSON.parse(out.trim()) as { type: string; id: string };
    assert.equal(row.type, 'subagent_event');
    assert.equal(row.id, 'sub-1');
  });
});

describe('createTextOutput', () => {
  it('正文走 stdout', () => {
    const output = createTextOutput();
    const out = captureStdout(() => output.listener({ type: 'text', text: 'hi' }));
    assert.equal(out, 'hi');
  });

  it('收尾是一个换行，不额外加内容', () => {
    assert.equal(createTextOutput().finalLine(), '\n');
  });
});
