import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { linuxBwrapArgs } from '../../src/sandbox/linux.js';

describe('linux bwrap args', () => {
  it('read-only 断网，workspace 不断网', () => {
    const ro = linuxBwrapArgs('read-only', '/ws', '/home/u/.sph', '/tmp/s');
    const ws = linuxBwrapArgs('workspace', '/ws', '/home/u/.sph', '/tmp/s');
    assert.ok(ro.includes('--unshare-net'));
    assert.ok(!ws.includes('--unshare-net'));
    assert.ok(ro.includes('--unshare-uts'));
    assert.ok(ws.includes('--hostname'));
  });
});
