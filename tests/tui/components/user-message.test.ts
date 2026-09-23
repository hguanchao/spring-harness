import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BLOCK_GAP } from '../../../src/tui/primitives.js';
import { OSC133_ZONE_START } from '../../../src/tui/utils.js';
import { UserMessageComponent } from '../../../src/plugins/sph-tui/components/user-message.js';

describe('UserMessageComponent OSC 133', () => {
  it('起点在气泡顶，不在块前空隙', () => {
    const lines = new UserMessageComponent('hello').render(40);
    assert.ok(lines.length > BLOCK_GAP);
    assert.equal(lines[0]?.startsWith(OSC133_ZONE_START), false);
    assert.equal(lines[BLOCK_GAP]?.startsWith(OSC133_ZONE_START), true);
  });
});
