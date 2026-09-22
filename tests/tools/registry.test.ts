import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultTools, tools } from '../../src/tools/index.js';

describe('default tool table flags', () => {
  it('default table includes aliases, subagent is parallel, root-only stays out of general', () => {
    assert.equal(tools.length, 15);
    assert.equal(defaultTools.list().length, 15);
    assert.equal(defaultTools.isConcurrencySafe('subagent'), true);
    assert.equal(defaultTools.isRootOnly('send_subagent_message'), true);
    assert.equal(defaultTools.generalNames().has('send_subagent_message'), false);
    assert.equal(defaultTools.exploreNames().has('read'), true);
    assert.equal(defaultTools.exploreNames().has('write'), false);
  });

  it('mcp 与 todo 不在核心表里——它们由插件注册', () => {
    // 回归点：MCP 曾是核心工具（19 个里的一个）。现在它的实现、工具与来源发现都在
    // plugins/sph-mcp，核心表里不该再有 mcp；插件被 [plugins] disabled 关掉时，
    // 模型看到的就是一张没有 mcp 的工具表。
    assert.equal(tools.some((tool) => tool.name === 'mcp'), false);
    assert.equal(defaultTools.find('mcp'), undefined);
    assert.equal(tools.some((tool) => tool.name === 'todo'), false);
    assert.equal(defaultTools.find('todo'), undefined);
    // plan 插件的两个工具也不在核心表里。
    assert.equal(tools.some((tool) => tool.name === 'enter_plan_mode'), false);
    assert.equal(defaultTools.find('exit_plan_mode'), undefined);
  });
});
