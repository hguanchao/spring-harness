import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { backoffMs, retryAfterMs } from '../../src/plugins/sph-llm/retry.js';

describe('retry', () => {
  it('Retry-After 秒数封顶 60s', () => {
    assert.equal(retryAfterMs('5'), 5000);
    assert.equal(retryAfterMs('120'), 60_000);
  });

  it('无 hint 时退避封顶 20s', () => {
    assert.ok(backoffMs(0, 1000) >= 1000);
    assert.ok(backoffMs(10, 1000) <= 20_000);
  });
});
