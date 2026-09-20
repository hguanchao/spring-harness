import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pinReservePad } from '../../../src/tui/components/scroll-view.js';

describe('pinReservePad', () => {
  it('no pin means no pad', () => {
    assert.equal(pinReservePad(40, 20, undefined), 0);
  });

  it('pads so the latest prompt can sit at the viewport top', () => {
    // content 40, viewport 20, pin at 30: remaining 10 < viewport, pad = 30+20-40 = 10
    assert.equal(pinReservePad(40, 20, 30), 10);
  });

  it('drops the pad once the reply is taller than the viewport', () => {
    // remaining 25 > viewport 20
    assert.equal(pinReservePad(50, 20, 25), 0);
  });

  it('second prompt after a long first reply can still pin', () => {
    // first turn filled 80 rows; second prompt at 80; remaining 0
    assert.equal(pinReservePad(80, 24, 80), 24);
  });
});
