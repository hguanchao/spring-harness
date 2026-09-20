import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hasPlanHeading, planBlockedReason, planFilePath, planHeading, planModeSection } from '../../src/agent/plan.js';

describe('plan heading', () => {
  it('requires an h1 at the start of the trimmed plan', () => {
    assert.equal(hasPlanHeading('# Ship it\n\nDo the thing.'), true);
    assert.equal(hasPlanHeading('  # Ship it'), true);
    assert.equal(hasPlanHeading('## Not h1\n# later'), false);
    assert.equal(hasPlanHeading('# '), false);
    assert.equal(hasPlanHeading('no heading'), false);
  });

  it('reads the first ATX heading for the review title', () => {
    assert.equal(planHeading('# Ship it\n\nbody'), 'Ship it');
    assert.equal(planHeading('intro\n## Details'), 'Details');
    assert.equal(planHeading('nope'), undefined);
  });
});

describe('planModeSection', () => {
  it('names the exit tool and the blocked writes', () => {
    const text = planModeSection();
    assert.ok(!text.includes('<plan_mode>'), '引导正文进的是状态消息，不该带 system 段标签');
    assert.ok(text.includes('exit_plan_mode'));
    assert.ok(text.includes('Do not implement'));
    assert.ok(planBlockedReason('write').includes('plan mode'));
  });
});

describe('planFilePath', () => {
  it('is session-scoped under the session directory', () => {
    assert.ok(planFilePath('/sessions', 'abc').endsWith('abc.plan.md'));
  });
});
