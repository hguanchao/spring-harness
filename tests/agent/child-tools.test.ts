import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveChildTools } from '../../src/plugins/sph-loop/loop.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { ToolSpec } from '../../src/tools/types.js';

function spec(name: string): ToolSpec {
  return {
    name,
    description: name,
    schema: { type: 'object', properties: {} },
    async execute() {
      return { ok: true, content: '' };
    },
  };
}

/** todo / task / send_subagent_message 都不在 sph-tools 的默认表里（各自插件注册），测试自建。 */
function childRegistry(): ToolRegistry {
  return new ToolRegistry([
    spec('read'),
    spec('bash'),
    spec('todo'),
    spec('task'),
    spec('send_subagent_message'),
  ]);
}

describe('子代理工具集（resolveChildTools）', () => {
  it("'*' 子代理拿不到委托工具，也拿不到 todo：清单是同进程共享实例", () => {
    const allowed = resolveChildTools(childRegistry(), ['*']);
    assert.equal(allowed.has('task'), false);
    assert.equal(allowed.has('send_subagent_message'), false);
    assert.equal(allowed.has('todo'), false, 'todo 剔除失效即串扰复现：子代理写清单会顶掉根会话的面板');
    assert.equal(allowed.has('read'), true);
    assert.equal(allowed.has('bash'), true);
  });

  it('显式点名的定义按名单原样生效，不做额外剔除', () => {
    const allowed = resolveChildTools(childRegistry(), ['read', 'grep', 'todo']);
    assert.equal(allowed.has('read'), true);
    assert.equal(allowed.has('todo'), true, "显式点名是定义作者的明确选择，'*' 之外不加拦截");
    assert.equal(allowed.has('grep'), false, '工具表里不存在的名字丢弃');
  });
});
