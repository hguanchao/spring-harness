import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultTools, tools } from './index.js';

describe('default tool table flags', () => {
  it('17 tools, subagent is parallel, root-only stays out of general', () => {
    assert.equal(tools.length, 17);
    assert.equal(defaultTools.list().length, 17);
    assert.equal(defaultTools.isConcurrencySafe('subagent'), true);
    assert.equal(defaultTools.isRootOnly('send_subagent_message'), true);
    assert.equal(defaultTools.generalNames().has('send_subagent_message'), false);
    assert.equal(defaultTools.exploreNames().has('read_file'), true);
    assert.equal(defaultTools.exploreNames().has('write'), false);
  });
});