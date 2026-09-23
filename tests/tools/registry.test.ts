import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultTools, tools } from '../../src/plugins/sph-tools/index.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { ToolSpec } from '../../src/tools/types.js';

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

  it('schema 按工具名排序，参数键递归排序，和注册顺序无关', () => {
    const execute: ToolSpec['execute'] = async () => ({ ok: true, content: '' });
    const registry = new ToolRegistry([
      {
        name: 'zeta',
        description: 'z',
        schema: { type: 'object', properties: { z: { type: 'string' }, a: { type: 'number' } } },
        execute,
      },
      {
        name: 'alpha',
        description: 'a',
        schema: { z: 1, a: { nested: true, earlier: false } },
        execute,
      },
    ]);
    const schemas = registry.schemas();
    assert.deepEqual(schemas.map((tool) => tool.function.name), ['alpha', 'zeta']);
    assert.deepEqual(Object.keys(schemas[0]?.function.parameters ?? {}), ['a', 'z']);
    const nested = (schemas[0]?.function.parameters as { a: Record<string, unknown> }).a;
    assert.deepEqual(Object.keys(nested), ['earlier', 'nested']);
    const zetaProps = (schemas[1]?.function.parameters as { properties: Record<string, unknown> }).properties;
    assert.deepEqual(Object.keys(zetaProps), ['a', 'z']);
    assert.equal(JSON.stringify(registry.schemas()), JSON.stringify(schemas));
  });

  it('插件工具不在核心表里', () => {
    // 关掉对应插件后，模型看到的工具表里不该再有这些名字。
    for (const name of ['mcp', 'todo', 'enter_plan_mode', 'exit_plan_mode', 'subagent', 'send_subagent_message']) {
      assert.equal(tools.some((tool) => tool.name === name), false, name);
      assert.equal(defaultTools.find(name), undefined, name);
    }
  });
});
