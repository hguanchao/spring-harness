import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  armHoverHighlight,
  clearedHoverNeedsRepaint,
  clearHoverHighlight,
} from '../../../src/plugins/sph-tui/components/hover-highlight.js';

describe('悬停离开后要重画', () => {
  it('清掉且没有新行接上时，缓存必须重画', () => {
    armHoverHighlight(() => true);
    const cleared = clearHoverHighlight();
    assert.equal(clearedHoverNeedsRepaint(cleared), true);
  });

  it('同一行接上悬停时不额外重画', () => {
    armHoverHighlight(() => true);
    const cleared = clearHoverHighlight();
    armHoverHighlight(() => false);
    assert.equal(clearedHoverNeedsRepaint(cleared), false);
    clearHoverHighlight();
  });
});
