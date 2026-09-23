import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { closeInterruptedTurn, findDanglingToolCalls, INTERRUPTED_TOOL, repairDanglingTools } from '../../src/plugins/sph-session/repair.js';
import { JsonlSession } from '../../src/plugins/sph-session/store.js';
import type { SessionMessage } from '../../src/session/types.js';

function msg(partial: Omit<SessionMessage, 'type' | 'ts'>): SessionMessage {
  return { type: 'message', ts: '2026-01-01T00:00:00.000Z', ...partial };
}

describe('findDanglingToolCalls', () => {
  it('returns nothing when every tool call has a result', () => {
    const dangling = findDanglingToolCalls([
      msg({ role: 'user', content: 'hi' }),
      msg({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'a.ts' } }],
      }),
      msg({ role: 'tool', content: 'ok', toolCallId: 'c1', toolName: 'read' }),
    ]);
    assert.deepEqual(dangling, []);
  });

  it('finds tool calls with no matching result', () => {
    const dangling = findDanglingToolCalls([
      msg({
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', name: 'read', arguments: {} },
          { id: 'c2', name: 'grep', arguments: {} },
        ],
      }),
    ]);
    assert.deepEqual(dangling, [
      { id: 'c1', name: 'read' },
      { id: 'c2', name: 'grep' },
    ]);
  });
});

describe('closeInterruptedTurn', () => {
  it('悬挂工具补完后关掉未结束的 turn', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sph-close-turn-'));
    try {
      const session = new JsonlSession(dir, 's1');
      session.appendEvent('turn_start', { depth: 0 });
      const messages: SessionMessage[] = [
        msg({
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'bash', arguments: {} }],
        }),
      ];
      assert.equal(closeInterruptedTurn(session, messages), 2);
      const records = session.readAll();
      const ends = records.filter((row) => row.type === 'event' && row.kind === 'turn_end');
      assert.equal(ends.length, 1);
      assert.equal((ends[0] as { data: { interrupted?: boolean } }).data.interrupted, true);
      const tool = records.find((row) => row.type === 'message' && row.role === 'tool');
      assert.match(String(tool && 'content' in tool ? tool.content : ''), /Do not retry blindly/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('repairDanglingTools', () => {
  it('appends synthetic tool results and is a no-op on a paired session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sph-repair-'));
    try {
      const session = new JsonlSession(dir, 's1');
      const messages: SessionMessage[] = [
        msg({
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'c1', name: 'bash', arguments: {} },
            { id: 'c2', name: 'grep', arguments: {} },
          ],
        }),
      ];
      assert.equal(repairDanglingTools(session, messages), 2);
      assert.equal(messages.length, 3);
      assert.equal(messages[1]?.content, INTERRUPTED_TOOL);
      assert.equal(messages[1]?.toolCallId, 'c1');
      assert.equal(messages[2]?.toolCallId, 'c2');
      const records = session.readAll();
      assert.equal(records.filter((row) => row.type === 'message' && row.role === 'tool').length, 2);
      assert.equal(records.filter((row) => row.type === 'event' && row.kind === 'tool_result').length, 2);
      assert.equal(repairDanglingTools(session, messages), 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
