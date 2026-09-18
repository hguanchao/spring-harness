import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultTools, tools } from './index.js';

describe('default tool table flags', () => {
  it('default table includes aliases, subagent is parallel, root-only stays out of general', () => {
    assert.equal(tools.length, 18);
    assert.equal(defaultTools.list().length, 18);
    assert.equal(defaultTools.isConcurrencySafe('subagent'), true);
    assert.equal(defaultTools.isRootOnly('send_subagent_message'), true);
    assert.equal(defaultTools.generalNames().has('send_subagent_message'), false);
    assert.equal(defaultTools.exploreNames().has('read'), true);
    assert.equal(defaultTools.exploreNames().has('write'), false);
  });
});