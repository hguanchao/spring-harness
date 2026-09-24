import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { foldSessionState, sessionEventData } from '../../src/plugins/sph-session/fold.js';
import type { SessionRecord } from '../../src/session/types.js';

function recapEvent(data: Record<string, unknown>): SessionRecord {
  return { type: 'event', ts: '2026-01-01T00:00:00.000Z', kind: 'recap', data };
}

describe('foldSessionState agent', () => {
  function agentEvent(name: unknown): SessionRecord {
    return { type: 'event', ts: '2026-01-01T00:00:00.000Z', kind: 'agent', data: { name } };
  }

  it('旧会话没有 agent 事件时不算选中', () => {
    assert.equal(foldSessionState([]).agent, undefined);
  });

  it('后一条覆盖前一条，空名字是切回默认', () => {
    assert.equal(foldSessionState([agentEvent('research'), agentEvent('')]).agent, '');
    assert.equal(foldSessionState([agentEvent('writer')]).agent, 'writer');
    assert.deepEqual(sessionEventData.agent('research'), { name: 'research' });
  });
});

describe('foldSessionState recap', () => {
  it('starts with no watermark and no recap', () => {
    const state = foldSessionState([]);
    assert.equal(state.lastRecapMainTurn, 0);
    assert.equal(state.lastRecap, undefined);
  });

  it('advances the watermark and keeps the summary', () => {
    const state = foldSessionState([
      recapEvent({ summary: 'first', auto: false, mainTurns: 2, shown: true }),
      recapEvent({ summary: 'second', auto: true, mainTurns: 5, shown: true }),
    ]);
    assert.equal(state.lastRecapMainTurn, 5);
    assert.equal(state.lastRecap, 'second');
  });

  it('records a suppressed recap for the watermark but keeps the last text', () => {
    const state = foldSessionState([
      recapEvent({ summary: 'runaway output', auto: true, mainTurns: 7, shown: false }),
    ]);
    assert.equal(state.lastRecapMainTurn, 7);
    assert.equal(state.lastRecap, 'runaway output');
  });

  it('tolerates malformed recap payloads without failing the fold', () => {
    const state = foldSessionState([
      recapEvent({ summary: 42, auto: 'yes', mainTurns: 'three' }),
      recapEvent({ summary: '   ', auto: true, mainTurns: -3 }),
      recapEvent({ summary: 'ok', auto: true, mainTurns: 2.9 }),
    ]);
    assert.equal(state.lastRecapMainTurn, 2);
    assert.equal(state.lastRecap, 'ok');
  });

  it('round-trips through sessionEventData', () => {
    const state = foldSessionState([
      recapEvent(sessionEventData.recap({ summary: 'wired up recap', auto: true, mainTurns: 4, shown: true })),
    ]);
    assert.equal(state.lastRecapMainTurn, 4);
    assert.equal(state.lastRecap, 'wired up recap');
  });

  it('folds plan_mode as last-wins', () => {
    const state = foldSessionState([
      { type: 'event', ts: 't', kind: 'plan_mode', data: sessionEventData.planMode(true) },
      { type: 'event', ts: 't', kind: 'plan_mode', data: sessionEventData.planMode(false) },
      { type: 'event', ts: 't', kind: 'plan_mode', data: sessionEventData.planMode(true) },
    ]);
    assert.equal(state.planMode, true);
  });

  it('treats missing plan_mode as inactive', () => {
    assert.equal(foldSessionState([]).planMode, false);
  });

  it('ignores unrelated events', () => {
    const state = foldSessionState([
      { type: 'event', ts: '2026-01-01T00:00:00.000Z', kind: 'goal', data: { text: 'ship it' } },
      { type: 'message', ts: '2026-01-01T00:00:00.000Z', role: 'user', content: 'hi' },
    ]);
    assert.equal(state.lastRecapMainTurn, 0);
    assert.equal(state.goal, 'ship it');
  });
});

describe('foldSessionState lastTurnInterrupted', () => {
  it('turn_end interrupted 折叠为 true，新 turn_start 清掉', () => {
    const state = foldSessionState([
      { type: 'event', ts: 't', kind: 'turn_start', data: { depth: 0 } },
      { type: 'event', ts: 't', kind: 'turn_end', data: { interrupted: true, depth: 0 } },
    ]);
    assert.equal(state.lastTurnInterrupted, true);
    const next = foldSessionState([
      { type: 'event', ts: 't', kind: 'turn_start', data: { depth: 0 } },
      { type: 'event', ts: 't', kind: 'turn_end', data: { interrupted: true, depth: 0 } },
      { type: 'event', ts: 't', kind: 'turn_start', data: { depth: 0 } },
    ]);
    assert.equal(next.lastTurnInterrupted, false);
  });
});

describe('foldSessionState tokensUsed', () => {
  function event(kind: string, data: Record<string, unknown>): SessionRecord {
    return { type: 'event', ts: '2026-01-01T00:00:00.000Z', kind, data };
  }

  it('累加自己的 usage（prompt + completion），辅助调用的也计', () => {
    const state = foldSessionState([
      event('usage', { promptTokens: 100, completionTokens: 20, totalTokens: 120 }),
      // 压缩摘要走的是便宜模型，但那是真花钱，一样计入。
      event('usage', { promptTokens: 30, completionTokens: 5, totalTokens: 35, purpose: 'compaction' }),
    ]);
    assert.equal(state.tokensUsed, 155);
  });

  it('计入子代理 end 事件的 tokens（含其后代），start 不计', () => {
    const state = foldSessionState([
      event('subagent', { phase: 'start', id: 'sub-1', description: 'x' }),
      event('subagent', { phase: 'end', id: 'sub-1', ok: true, tokens: 400, durationMs: 10, summary: 'y' }),
    ]);
    assert.equal(state.tokensUsed, 400);
  });

  it('自己的用量与子代理的用量不相交，不会重复计', () => {
    const state = foldSessionState([
      event('usage', { promptTokens: 10, completionTokens: 10, totalTokens: 20 }),
      event('subagent', { phase: 'end', id: 'sub-1', ok: true, tokens: 50, durationMs: 1, summary: 's' }),
      event('usage', { promptTokens: 20, completionTokens: 20, totalTokens: 40 }),
    ]);
    assert.equal(state.tokensUsed, 110, '20 + 50 + 40：两部分各自计入，没有重复');
  });

  it('坏数据（缺字段/负数/非数字）不污染累计量', () => {
    const state = foldSessionState([
      event('usage', {}),
      event('usage', { promptTokens: 'many', completionTokens: null }),
      event('usage', { promptTokens: -100, completionTokens: 10 }),
      event('subagent', { phase: 'end', tokens: 'lots' }),
    ]);
    assert.equal(state.tokensUsed, 10);
  });

  it('空会话为 0', () => {
    assert.equal(foldSessionState([]).tokensUsed, 0);
  });
});
