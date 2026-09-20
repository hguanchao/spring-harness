import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseArgs } from '../../src/cli/args.js';

describe('--output-format', () => {
  it('默认 text', () => {
    assert.equal(parseArgs(['-p', 'hi']).outputFormat, 'text');
  });

  it('两种写法都接受', () => {
    assert.equal(parseArgs(['-p', 'hi', '--output-format', 'json']).outputFormat, 'json');
    assert.equal(parseArgs(['-p', 'hi', '--output-format=json']).outputFormat, 'json');
  });

  it('非法值或缺失值直接报错', () => {
    assert.throws(() => parseArgs(['-p', 'hi', '--output-format', 'yaml']), /text \| json/);
    assert.throws(() => parseArgs(['-p', 'hi', '--output-format']), /text \| json/);
  });

  it('没有 -p 时拒绝，而不是静默忽略', () => {
    // TUI 与 sessions/export 都没有机器可读输出，写错了应当立刻知道。
    assert.throws(() => parseArgs(['--output-format', 'json']), /requires -p/);
    assert.throws(() => parseArgs(['sessions', '--output-format', 'json']), /requires -p/);
  });
});
