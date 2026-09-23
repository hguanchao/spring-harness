import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ABORTED_BEFORE_DISPATCH, runToolBatch, type ToolCallRequest } from '../../src/agent/tool-run.js';
import { isConcurrencySafe } from '../../src/tools/index.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function call(id: string, name: string): ToolCallRequest {
  return { id, name, arguments: {} };
}

describe('isConcurrencySafe', () => {
  it('treats read-like tools as parallel and writers as exclusive', () => {
    assert.equal(isConcurrencySafe('read'), true);
    assert.equal(isConcurrencySafe('web_search'), true);
    assert.equal(isConcurrencySafe('glob'), true);
    assert.equal(isConcurrencySafe('write'), false);
    assert.equal(isConcurrencySafe('unknown_tool'), false);
  });
});

describe('runToolBatch', () => {
  it('commits in model order even when a later parallel call finishes first', async () => {
    const committed: string[] = [];
    await runToolBatch({
      calls: [call('a', 'read'), call('b', 'read')],
      isParallel: () => true,
      async execute(item) {
        await sleep(item.id === 'a' ? 40 : 5);
        return { ok: true, content: item.id };
      },
      onStart() {},
      onCommit(item) {
        committed.push(item.id);
      },
    });
    assert.deepEqual(committed, ['a', 'b']);
  });

  it('holds exclusive tools until the preceding parallel batch drains', async () => {
    const events: string[] = [];
    await runToolBatch({
      calls: [call('r', 'read'), call('t', 'todo')],
      isParallel: (name) => name !== 'todo',
      async execute(item) {
        events.push(`exec:${item.id}`);
        if (item.id === 'r') await sleep(20);
        return { ok: true, content: item.id };
      },
      onStart() {},
      onCommit() {},
    });
    assert.deepEqual(events, ['exec:r', 'exec:t']);
  });

  it('does not dispatch remaining exclusive calls after abort', async () => {
    const started: string[] = [];
    const committed: Array<{ id: string; content: string }> = [];
    const ac = new AbortController();
    await runToolBatch({
      calls: [call('a', 'write'), call('b', 'write')],
      isParallel: () => false,
      async execute(item) {
        started.push(item.id);
        ac.abort();
        return { ok: true, content: item.id };
      },
      onStart() {},
      onCommit(item, result) {
        committed.push({ id: item.id, content: result.content });
      },
      signal: ac.signal,
    });
    assert.deepEqual(started, ['a']);
    assert.deepEqual(committed, [
      { id: 'a', content: 'a' },
      { id: 'b', content: ABORTED_BEFORE_DISPATCH },
    ]);
  });

  it('turns execute throws into error results so later slots still commit', async () => {
    const committed: Array<{ id: string; ok: boolean }> = [];
    await runToolBatch({
      calls: [call('a', 'read'), call('b', 'read')],
      isParallel: () => true,
      async execute(item) {
        if (item.id === 'a') throw new Error('boom');
        return { ok: true, content: 'b' };
      },
      onStart() {},
      onCommit(item, result) {
        committed.push({ id: item.id, ok: result.ok });
      },
    });
    assert.deepEqual(committed, [
      { id: 'a', ok: false },
      { id: 'b', ok: true },
    ]);
  });
});
