import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lineage, loadTip, messagesOnPath } from '../../src/session/tree.js';
import type { SessionRecord } from '../../src/session/types.js';

function msg(id: string, parentId: string | null, content: string): SessionRecord {
  return { type: 'message', ts: 't', role: 'user', content, id, parentId };
}

describe('session tree', () => {
  it('无 id 的旧记录按线性全文返回', () => {
    const records: SessionRecord[] = [
      { type: 'message', ts: 't', role: 'user', content: 'a' },
      { type: 'message', ts: 't', role: 'assistant', content: 'b' },
    ];
    assert.equal(lineage(records).length, 2);
    assert.equal(messagesOnPath(records).length, 2);
  });

  it('从 tip 回溯，弃枝不在路上', () => {
    const records: SessionRecord[] = [
      msg('a', null, 'root'),
      { type: 'message', ts: 't', role: 'assistant', content: 'ok', id: 'b', parentId: 'a' },
      msg('c', 'b', 'branch-1'),
      msg('d', 'b', 'branch-2'),
    ];
    const path = messagesOnPath(records, 'd').map((row) => row.id);
    assert.deepEqual(path, ['a', 'b', 'd']);
    assert.equal(loadTip([...records, { type: 'event', ts: 't', kind: 'branch_tip', data: { id: 'c' } }]), 'c');
  });
});
