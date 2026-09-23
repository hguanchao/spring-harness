import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { JsonlSession, listSessions, resumeOrCreate } from '../../src/plugins/sph-session/store.js';

function fixture(): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sph-sessions-'));
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 造一个会话文件：若干轮问答，外加若干「派生了哪些子代理」的 start 事件。 */
function seed(dir: string, id: string, input: { prompts: string[]; children?: string[] }): void {
  const session = new JsonlSession(dir, id);
  for (const prompt of input.prompts) {
    session.appendMessage({ role: 'user', content: prompt });
    // 固定回复：预览取首条 user，关键词命中数也才等于 user 消息数。
    session.appendMessage({ role: 'assistant', content: 'acknowledged' });
  }
  for (const child of input.children ?? []) {
    session.appendEvent('subagent', {
      phase: 'start',
      id: `sub-${child}`,
      description: `task ${child}`,
      mode: 'foreground',
      childType: 'general',
      childSessionId: child,
    });
  }
}

/** 只写事件、没有任何消息的会话（建了文件就没下文）。 */
function seedEmpty(dir: string, id: string): void {
  new JsonlSession(dir, id).appendEvent('turn_start', { depth: 0 });
}

/** 固定 mtime，避免同毫秒创建导致顺序不确定。 */
function stamp(dir: string, id: string, iso: string): void {
  const at = new Date(iso);
  utimesSync(join(dir, `${id}.jsonl`), at, at);
}

/**
 * 目录形状：
 *   root1 ──┬─ sub1 ── grand1
 *           └─ sub2
 *   orphan 只写事件、没有消息
 */
function seedTree(dir: string): void {
  seed(dir, 'root1', { prompts: ['main question'], children: ['sub1', 'sub2'] });
  seed(dir, 'sub1', { prompts: ['parser walkthrough'], children: ['grand1'] });
  seed(dir, 'sub2', { prompts: ['renderer tuning'] });
  seed(dir, 'grand1', { prompts: ['nested tracing'] });
  seedEmpty(dir, 'orphan');
  stamp(dir, 'root1', '2026-01-01T00:00:00Z');
  stamp(dir, 'sub1', '2026-02-01T00:00:00Z');
  stamp(dir, 'sub2', '2026-03-01T00:00:00Z');
  stamp(dir, 'grand1', '2026-04-01T00:00:00Z');
}

describe('listSessions', () => {
  it('lists main sessions only, with their subagent count', async () => {
    const { dir, dispose } = fixture();
    try {
      seedTree(dir);
      const infos = await listSessions(dir);
      assert.deepEqual(infos.map((info) => info.id), ['root1']);
      assert.equal(infos[0]?.subagents, 2, 'sub1 and sub2 belong to root1');
      assert.equal(infos[0]?.parentId, undefined);
    } finally {
      dispose();
    }
  });

  it('returns the whole tree when subagents are asked for, each tagged with its parent', async () => {
    const { dir, dispose } = fixture();
    try {
      seedTree(dir);
      const infos = await listSessions(dir, { includeSubagents: true });
      const byId = new Map(infos.map((info) => [info.id, info]));
      assert.deepEqual([...byId.keys()].sort(), ['grand1', 'root1', 'sub1', 'sub2']);
      assert.equal(byId.get('root1')?.parentId, undefined);
      assert.equal(byId.get('sub1')?.parentId, 'root1');
      assert.equal(byId.get('sub2')?.parentId, 'root1');
      // 孙代归它的直接父级，不归 root。
      assert.equal(byId.get('grand1')?.parentId, 'sub1');
      assert.equal(byId.get('sub1')?.subagents, 1);
    } finally {
      dispose();
    }
  });

  it('sorts main sessions by mtime, newest first', async () => {
    const { dir, dispose } = fixture();
    try {
      seedTree(dir);
      seed(dir, 'root2', { prompts: ['later main question'] });
      stamp(dir, 'root2', '2026-07-01T00:00:00Z');
      const infos = await listSessions(dir);
      assert.deepEqual(infos.map((info) => info.id), ['root2', 'root1']);
    } finally {
      dispose();
    }
  });

  it('skips files that have no messages', async () => {
    const { dir, dispose } = fixture();
    try {
      seedTree(dir);
      const ids = (await listSessions(dir, { includeSubagents: true })).map((info) => info.id);
      assert.ok(!ids.includes('orphan'));
    } finally {
      dispose();
    }
  });

  it('filters by keyword without leaking subagent transcripts', async () => {
    const { dir, dispose } = fixture();
    try {
      seedTree(dir);
      // "parser walkthrough" 只出现在 sub1 的转录里：主会话不该命中。
      assert.deepEqual(await listSessions(dir, { search: 'parser walkthrough' }), []);
      const all = await listSessions(dir, { search: 'parser walkthrough', includeSubagents: true });
      assert.deepEqual(all.map((info) => info.id), ['sub1']);
      assert.equal(all[0]?.hits, 1);
      assert.equal(all[0]?.parentId, 'root1');
    } finally {
      dispose();
    }
  });

  it('returns nothing for a directory that does not exist', async () => {
    assert.deepEqual(await listSessions(join(tmpdir(), 'sph-no-such-dir-xyz')), []);
  });
});

describe('resumeOrCreate', () => {
  it('creates a fresh session when asked to', async () => {
    const { dir, dispose } = fixture();
    try {
      seedTree(dir);
      const session = await resumeOrCreate(dir, 'E:\\ws', true);
      assert.ok(!['root1', 'sub1', 'sub2', 'grand1'].includes(session.id));
    } finally {
      dispose();
    }
  });

  it('resumes a main session even when subagent files are newer', async () => {
    const { dir, dispose } = fixture();
    try {
      seedTree(dir);
      // sub2 / grand1 的 mtime 都比 root1 新：按时间或文件名排序都可能挑中它们。
      const session = await resumeOrCreate(dir, 'E:\\ws', false);
      assert.equal(session.id, 'root1');
    } finally {
      dispose();
    }
  });

  it('prefers the session recorded in current.json', async () => {
    const { dir, dispose } = fixture();
    try {
      seedTree(dir);
      const chosen = await resumeOrCreate(dir, 'E:\\ws', false);
      const again = await resumeOrCreate(dir, 'E:\\ws', false);
      assert.equal(again.id, chosen.id);
    } finally {
      dispose();
    }
  });

  it('never resumes a message-less session', async () => {
    const { dir, dispose } = fixture();
    try {
      seedEmpty(dir, 'orphan');
      const session = await resumeOrCreate(dir, 'E:\\ws', false);
      assert.notEqual(session.id, 'orphan');
    } finally {
      dispose();
    }
  });
});
