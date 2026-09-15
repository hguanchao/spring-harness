import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  computeStickyLayout,
  HEADER_CONTENT_GAP,
  type PromptDescriptor,
} from './sticky-user-message.js';

function makePrompts(specs: ReadonlyArray<readonly [number, number]>, minHeight = 4): PromptDescriptor[] {
  return specs.map(([yVirtual, fullHeight], index) => ({
    index,
    yVirtual,
    fullHeight,
    minHeight,
    sticky: true,
  }));
}

describe('computeStickyLayout', () => {
  it('no prompts', () => {
    const layout = computeStickyLayout(10, 24, []);
    assert.equal(layout.pinned, undefined);
    assert.equal(layout.pushed, undefined);
  });

  it('no scroll', () => {
    const layout = computeStickyLayout(0, 24, makePrompts([[0, 6], [20, 6]]));
    assert.equal(layout.pinned, undefined);
    assert.equal(layout.pushed, undefined);
  });

  it('gradual collapse just scrolled past', () => {
    const layout = computeStickyLayout(1, 24, makePrompts([[0, 8]]));
    assert.deepEqual(layout.pinned, { index: 0, renderHeight: 7, clipTop: 0 });
    assert.equal(layout.pushed, undefined);
  });

  it('gradual collapse more scrolled', () => {
    const layout = computeStickyLayout(3, 24, makePrompts([[0, 8]]));
    assert.deepEqual(layout.pinned, { index: 0, renderHeight: 5, clipTop: 0 });
  });

  it('gradual collapse reaches minimum', () => {
    const layout = computeStickyLayout(6, 24, makePrompts([[0, 8]]));
    assert.deepEqual(layout.pinned, { index: 0, renderHeight: 4, clipTop: 0 });
  });

  it('gradual collapse stays at minimum', () => {
    const layout = computeStickyLayout(10, 24, makePrompts([[0, 8]]));
    assert.deepEqual(layout.pinned, { index: 0, renderHeight: 4, clipTop: 0 });
  });

  it('min height clamped to full height', () => {
    const layout = computeStickyLayout(10, 24, [
      { index: 0, yVirtual: 0, fullHeight: 1, minHeight: 6, sticky: true },
    ]);
    assert.deepEqual(layout.pinned, { index: 0, renderHeight: 1, clipTop: 0 });
  });

  it('push effect', () => {
    const prompts = makePrompts([[0, 8], [9, 8]]);
    assert.equal(computeStickyLayout(8, 24, prompts).pushed, undefined);
    assert.equal(computeStickyLayout(8, 24, prompts).pinned, undefined);

    const at7 = computeStickyLayout(7, 24, prompts);
    assert.equal(at7.pinned, undefined);
    assert.equal(at7.pushed?.index, 0);
    assert.equal(at7.pushed && at7.pushed.renderHeight - at7.pushed.clipTop, 1);

    const at6 = computeStickyLayout(6, 24, prompts);
    assert.equal(at6.pushed && at6.pushed.renderHeight - at6.pushed.clipTop, 2);
  });

  it('next prompt becomes pinned', () => {
    const layout = computeStickyLayout(13, 24, makePrompts([[0, 8], [12, 8]]));
    assert.deepEqual(layout.pinned, { index: 1, renderHeight: 7, clipTop: 0 });
  });

  it('second prompt at viewport top clears the first sticky header', () => {
    // 第二条刚好停在视口顶：nextNaiveRow=0，overlay 撤掉，内联气泡就是最新一条。
    const atTop = computeStickyLayout(40, 24, makePrompts([[0, 6], [40, 6]]));
    assert.equal(atTop.pinned, undefined);
    assert.equal(atTop.pushed, undefined);

    // 再滚过 1 行，第二条才自己吸顶。
    const past = computeStickyLayout(41, 24, makePrompts([[0, 6], [40, 6]]));
    assert.deepEqual(past.pinned, { index: 1, renderHeight: 5, clipTop: 0 });
  });

  it('push uses header gap of 1', () => {
    assert.equal(HEADER_CONTENT_GAP, 1);
    const prompts = makePrompts([[0, 4], [10, 4]]);
    const beforePush = computeStickyLayout(4, 24, prompts);
    assert.ok(beforePush.pinned);
    const enteringPush = computeStickyLayout(5, 24, prompts);
    assert.ok(enteringPush.pushed);
    assert.equal(enteringPush.pinned, undefined);
  });

  it('long prompt shrinks 1:1 then clamps to minHeight', () => {
    const prompts = makePrompts([[0, 20]], 5);
    const justPast = computeStickyLayout(1, 24, prompts);
    assert.equal(justPast.pinned?.renderHeight, 19);
    const mid = computeStickyLayout(10, 24, prompts);
    assert.equal(mid.pinned?.renderHeight, 10);
    const far = computeStickyLayout(30, 24, prompts);
    assert.equal(far.pinned?.renderHeight, 5);
  });
});
