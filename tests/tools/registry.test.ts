import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultTools, tools } from '../../src/plugins/sph-tools/index.js';

describe('default tool table flags', () => {
  it('只读探索工具可并行，写工具不行；explore 集合不含 write', () => {
    assert.equal(tools.length, 13);
    assert.equal(defaultTools.list().length, 13);
    assert.equal(defaultTools.exploreNames().has('read'), true);
    assert.equal(defaultTools.exploreNames().has('write'), false);
    assert.equal(defaultTools.isPlanSafe('read'), true);
    assert.equal(defaultTools.isPlanSafe('write'), false);
    assert.equal(defaultTools.isPlanSafe('bash'), false);
  });

  it('插件工具不在核心表里', () => {
    // 关掉对应插件后，模型看到的工具表里不该再有这些名字。
    for (const name of ['mcp', 'todo', 'enter_plan_mode', 'exit_plan_mode', 'subagent', 'send_subagent_message']) {
      assert.equal(tools.some((tool) => tool.name === name), false, name);
      assert.equal(defaultTools.find(name), undefined, name);
    }
  });
});
