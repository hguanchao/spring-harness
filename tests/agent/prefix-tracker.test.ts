import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hashMessage, hashText, observePrefix, type PrefixSnapshot } from '../../src/plugins/sph-loop/prefix-tracker.js';

function snapshot(overrides: Partial<PrefixSnapshot> = {}): PrefixSnapshot {
  return {
    toolsHash: 'tools-1',
    systemHash: 'system-1',
    messageHashes: ['m1', 'm2', 'm3'],
    ...overrides,
  };
}

describe('observePrefix', () => {
  it('首轮无基线时不报任何变更', () => {
    assert.deepEqual(observePrefix(undefined, snapshot()), []);
  });

  it('纯追加（上一轮是本轮的前缀）是合法形态，不报', () => {
    const prev = snapshot();
    const next = snapshot({ messageHashes: ['m1', 'm2', 'm3', 'm4', 'm5'] });
    assert.deepEqual(observePrefix(prev, next), []);
  });

  it('tools 段变更直接报（MCP reload / 子代理工具集）', () => {
    const changes = observePrefix(snapshot(), snapshot({ toolsHash: 'tools-2' }));
    assert.deepEqual(changes, [{ segment: 'tools' }]);
  });

  it('system 段变更直接报（skills / AGENTS.md）', () => {
    const changes = observePrefix(snapshot(), snapshot({ systemHash: 'system-2' }));
    assert.deepEqual(changes, [{ segment: 'system' }]);
  });

  it('消息中段分叉报出起始下标（compact / 投影 bug）', () => {
    const changes = observePrefix(snapshot(), snapshot({ messageHashes: ['m1', 'X', 'm3'] }));
    assert.deepEqual(changes, [{ segment: 'messages', fromIndex: 1 }]);
  });

  it('多条段同时变更时全部报出', () => {
    const changes = observePrefix(
      snapshot({ systemHash: 'old', messageHashes: ['a', 'b'] }),
      snapshot({ messageHashes: ['a', 'b', 'c'] }),
    );
    assert.deepEqual(changes, [{ segment: 'system' }]);
  });

  it('上一轮更长且本轮完全收缩（折叠后）时报分叉', () => {
    const changes = observePrefix(
      snapshot({ messageHashes: ['m1', 'm2', 'm3'] }),
      snapshot({ messageHashes: ['m1'] }),
    );
    assert.deepEqual(changes, [{ segment: 'messages', fromIndex: 1 }], '历史变短且尾部消失不是追加');
  });
});

describe('hashMessage / hashText', () => {
  it('同一内容稳定，内容变化则 hash 变化', () => {
    const a = hashMessage({ role: 'user', content: 'hello' });
    assert.equal(a, hashMessage({ role: 'user', content: 'hello' }));
    assert.notEqual(a, hashMessage({ role: 'user', content: 'hello!' }));
    assert.notEqual(a, hashMessage({ role: 'assistant', content: 'hello' }), 'role 变化也要能检出');
  });

  it('tool_calls 等结构字段参与 hash', () => {
    const base = { role: 'assistant', content: '' };
    assert.notEqual(
      hashMessage(base),
      hashMessage({ ...base, tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }] }),
    );
  });

  it('hashText 输出 16 位十六进制（事件里可读即可）', () => {
    assert.match(hashText('x'), /^[0-9a-f]{16}$/);
  });
});
