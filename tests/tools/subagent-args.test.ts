import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EMPTY_PLUGIN_SERVICES } from '../../src/plugins/types.js';
import { subagentTool } from '../../src/tools/subagent.js';
import type { ToolContext } from '../../src/tools/types.js';

interface Spawned {
  type: string;
  isolation?: string;
  background?: boolean;
}

function ctx(spawned: Spawned[], approvals: string[] = []): ToolContext {
  return {
    workspaceRoot: process.cwd(),
    sandboxMode: 'off',
    skills: [],
    todos: {} as ToolContext['todos'],
    jobs: {} as ToolContext['jobs'],
    services: EMPTY_PLUGIN_SERVICES,
    runShell: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    approve: async (tool: string, detail: string) => {
      approvals.push(`${tool}|${detail}`);
      return true;
    },
    askUser: async () => '',
    noteMemoryTouch() {},
    spawnSubagent: async (input) => {
      spawned.push({ type: input.type, isolation: input.isolation, background: input.background });
      return 'done';
    },
    sendToSubagent: () => 'not_found',
  };
}

describe('subagent 参数校验', () => {
  it('type 拼错时拒绝，而不是静默落到 general', async () => {
    const spawned: Spawned[] = [];
    for (const bad of ['Explore', 'readonly', 'GENERAL']) {
      const result = await subagentTool.execute({ prompt: 'p', description: 'd', type: bad }, ctx(spawned));
      assert.equal(result.ok, false, bad);
      assert.match(result.content, /type must be "explore" or "general"/);
    }
    assert.equal(spawned.length, 0, '不该派生出任何子代理');
  });

  it('isolation 拼错时拒绝，而不是静默降级成不隔离', async () => {
    const spawned: Spawned[] = [];
    const result = await subagentTool.execute({ prompt: 'p', description: 'd', isolation: 'Worktree' }, ctx(spawned));
    assert.equal(result.ok, false);
    assert.match(result.content, /isolation must be "none" or "worktree"/);
    assert.equal(spawned.length, 0);
  });

  it('合法取值与省略照常工作', async () => {
    const spawned: Spawned[] = [];
    const c = ctx(spawned);
    assert.equal((await subagentTool.execute({ prompt: 'p', description: 'd' }, c)).ok, true);
    assert.equal((await subagentTool.execute({ prompt: 'p', description: 'd', type: 'explore' }, c)).ok, true);
    assert.equal(
      (await subagentTool.execute({ prompt: 'p', description: 'd', type: 'general', isolation: 'worktree' }, c)).ok,
      true,
    );
    assert.deepEqual(spawned.map((s) => [s.type, s.isolation]), [
      ['general', 'none'],
      ['explore', 'none'],
      ['general', 'worktree'],
    ]);
  });
});
