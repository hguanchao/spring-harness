import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultTools, tools } from '../../src/tools/index.js';

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

  it('mcp 不在核心表里——它由 sph-mcp 插件注册', () => {
    // 回归点：MCP 曾是核心工具（19 个里的一个）。现在它的实现、工具与来源发现都在
    // plugins/sph-mcp，核心表里不该再有 mcp；插件被 [plugins] disabled 关掉时，
    // 模型看到的就是一张没有 mcp 的工具表。
    assert.equal(tools.some((tool) => tool.name === 'mcp'), false);
    assert.equal(defaultTools.find('mcp'), undefined);
  });
});
