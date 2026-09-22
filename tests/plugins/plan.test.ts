import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import setup from '../../src/plugins/plan/index.js';
import { PLAN_MODE_SERVICE, type PlanModeSeam } from '../../src/plugins/services.js';
import { EMPTY_PLUGIN_SERVICES, type PluginApi, type PluginHostFacts } from '../../src/plugins/types.js';
import type { ToolSpec } from '../../src/tools/types.js';

function harness(): { api: PluginApi; tools: ToolSpec[]; services: Map<string, unknown> } {
  const tools: ToolSpec[] = [];
  const services = new Map<string, unknown>();
  const host: PluginHostFacts = {
    sphHome: process.cwd(),
    mergeChildEnv: (extra) => ({ ...(extra ?? {}) }),
    canonicalize: (p) => p,
    isWorkspaceTrusted: () => true,
  };
  const api: PluginApi = {
    name: 'plan',
    workspaceRoot: process.cwd(),
    configPath: 'config.toml',
    host,
    registerTool: (tool) => tools.push(tool),
    provide: (name, service) => services.set(name, service),
    consume: () => undefined,
    warn: () => {},
    clip: (text, limit = 32 * 1024) => (text.length <= limit ? text : text.slice(0, limit)),
    onDispose: () => {},
  };
  return { api, tools, services };
}

function seam(): PlanModeSeam {
  const h = harness();
  setup(h.api);
  const s = h.services.get(PLAN_MODE_SERVICE) as PlanModeSeam;
  assert.ok(s, '应提供 plan 服务');
  return s;
}

describe('plan 插件装载', () => {
  it('注册 enter/exit_plan_mode 两个工具，并以 plan 为名提供服务', () => {
    const h = harness();
    setup(h.api);
    assert.deepEqual(h.tools.map((tool) => tool.name).sort(), ['enter_plan_mode', 'exit_plan_mode']);
    assert.ok(h.services.has(PLAN_MODE_SERVICE), '应提供 plan 服务');
  });

  it('拦截表按名字 + 参数豁免：write 拦、explore 子代理放行、general 拦', () => {
    const s = seam();
    for (const name of ['write', 'edit', 'bash', 'pwsh', 'mcp', 'send_subagent_message']) {
      assert.equal(s.isBlocked(name, {}), true, `${name} 应被拦`);
    }
    assert.equal(s.isBlocked('read', {}), false, '只读工具不拦');
    assert.equal(s.isBlocked('subagent', { type: 'explore' }), false, 'explore 子代理只读，放行');
    assert.equal(s.isBlocked('subagent', { type: 'general' }), true, 'general 子代理会写，拦');
    assert.equal(s.isBlocked('subagent', {}), true, '类型不明按最坏处理（拦）');
    assert.match(s.blockedReason('write'), /blocked in plan mode: write/);
  });

  it('引导正文与计划格式校验由插件声明', () => {
    const s = seam();
    assert.match(s.promptSection(), /Do not implement/);
    assert.match(s.promptSection(), /exit_plan_mode/);
    assert.equal(s.hasPlanHeading('# Title'), true);
    assert.equal(s.hasPlanHeading('no heading'), false);
    assert.equal(s.planHeading('# 我的计划\n正文'), '我的计划');
    assert.ok(s.planFilePath('/sessions', 'abc').endsWith('abc.plan.md'), '计划落盘路径按平台分隔符拼接');
  });
});

describe('plan 插件缺席语义', () => {
  it('服务不在时，核心的拦截点取不到 seam——plan mode 无法进入也就不需要拦截', () => {
    // 这是「降级但安全」的核心：EMPTY_PLUGIN_SERVICES 是插件未装时的服务表，
    // 核心用它拿到 undefined，拦截点什么都不拦；而 enter_plan_mode 工具也不在
    // 工具表里，模型根本无法进入 plan mode。
    assert.equal(EMPTY_PLUGIN_SERVICES.get(PLAN_MODE_SERVICE), undefined);
  });
});
