import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { foldSessionState, sessionEventData } from './fold.js';
import type { SessionRecord } from './types.js';

function recapEvent(data: Record<string, unknown>): SessionRecord {
  return { type: 'event', ts: '2026-01-01T00:00:00.000Z', kind: 'recap', data };
}

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
