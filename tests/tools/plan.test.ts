import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { planFilePath } from '../../src/plugins/sph-plan/plan-core.js';
import { enterPlanModeTool, exitPlanModeTool } from '../../src/plugins/sph-plan/tool.js';
import { EMPTY_PLUGIN_SERVICES } from '../../src/plugins/types.js';
import type { ToolContext } from '../../src/tools/types.js';

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  const planMode = overrides.planMode ?? { active: false };
  return {
    workspaceRoot: '/ws',
    sandboxMode: 'off',
    skills: [],
    todos: {} as ToolContext['todos'],
    jobs: {} as ToolContext['jobs'],
    services: EMPTY_PLUGIN_SERVICES,
    runShell: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    approve: async () => true,
    askUser: async () => '',
    noteMemoryTouch() {},
    spawnSubagent: async () => '',
    sendToSubagent: () => 'not_found',
    planMode,
    setPlanMode(active) {
      planMode.active = active;
    },
    ...overrides,
  };
}

describe('enter_plan_mode', () => {
  it('turns plan mode on after approval', async () => {
    const box = { active: false };
    const result = await enterPlanModeTool.execute({}, ctx({ planMode: box }), 'c1');
    assert.equal(result.ok, true);
    assert.equal(box.active, true);
    assert.ok(result.content.includes('Plan mode is on'));
  });

  it('is a no-op when already active', async () => {
    const result = await enterPlanModeTool.execute({}, ctx({ planMode: { active: true } }), 'c1');
    assert.equal(result.ok, true);
    assert.ok(result.content.includes('Already in plan mode'));
  });

  it('stops when the user declines', async () => {
    const box = { active: false };
    const result = await enterPlanModeTool.execute({}, ctx({ planMode: box, approve: async () => false }), 'c1');
    assert.equal(result.ok, false);
    assert.equal(box.active, false);
  });
});

describe('exit_plan_mode', () => {
  it('rejects calls outside plan mode or without a heading', async () => {
    const off = await exitPlanModeTool.execute({ plan: '# Title\nbody' }, ctx({ planMode: { active: false } }), 'c1');
    assert.equal(off.ok, false);
    const box = { active: true };
    const bad = await exitPlanModeTool.execute({ plan: 'no heading' }, ctx({ planMode: box }), 'c1');
    assert.equal(bad.ok, false);
    assert.equal(box.active, true);
  });

  it('exits on approval and writes the plan file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sph-plan-'));
    try {
      const box = { active: true };
      const result = await exitPlanModeTool.execute(
        { plan: '# Ship it\n\nDo the thing.' },
        ctx({
          planMode: box,
          sessionDir: dir,
          sessionId: 's1',
          reviewPlan: async () => ({ approved: true }),
        }),
        'c1',
      );
      assert.equal(result.ok, true);
      assert.equal(box.active, false);
      const saved = readFileSync(planFilePath(dir, 's1'), 'utf8');
      assert.ok(saved.startsWith('# Ship it'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps plan mode on when the user wants to revise', async () => {
    const box = { active: true };
    const result = await exitPlanModeTool.execute(
      { plan: '# Draft\n\nMore research.' },
      ctx({
        planMode: box,
        reviewPlan: async () => ({ approved: false, feedback: 'cover the error path' }),
      }),
      'c1',
    );
    assert.equal(result.ok, false);
    assert.equal(box.active, true);
    assert.ok(result.content.includes('cover the error path'));
  });
});
