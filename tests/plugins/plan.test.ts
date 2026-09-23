import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import setup from '../../src/plugins/sph-plan/index.js';
import { PLAN_MODE_SERVICE, SUBAGENT_SERVICE, type PlanModeSeam, type SubagentCatalog } from '../../src/plugins/services.js';
import { EMPTY_PLUGIN_SERVICES, type PluginApi, type PluginHostFacts } from '../../src/plugins/types.js';
import type { ToolSpec } from '../../src/tools/types.js';

function harness(catalog?: SubagentCatalog): { api: PluginApi; tools: ToolSpec[]; services: Map<string, unknown> } {
  const tools: ToolSpec[] = [];
  const services = new Map<string, unknown>();
  const host: PluginHostFacts = {
    sphHome: process.cwd(),
    mergeChildEnv: (extra) => ({ ...(extra ?? {}) }),
    canonicalize: (p) => p,
    isWorkspaceTrusted: () => true,
  };
  const api: PluginApi = {
    name: 'sph-plan',
    workspaceRoot: process.cwd(),
    configPath: 'config.toml',
    host,
    registerTool: (tool) => tools.push(tool),
    provide: (name, service) => services.set(name, service),
    consume: <T>(name: string): T | undefined => (name === SUBAGENT_SERVICE ? catalog as T : undefined),
    warn: () => {},
    clip: (text, limit = 32 * 1024) => (text.length <= limit ? text : text.slice(0, limit)),
    onDispose: () => {},
  };
  return { api, tools, services };
}

function seam(catalog?: SubagentCatalog): PlanModeSeam {
  const h = harness(catalog);
  setup(h.api);
  const s = h.services.get(PLAN_MODE_SERVICE) as PlanModeSeam;
  assert.ok(s, '应提供 sph-plan 服务');
  return s;
}

describe('sph-plan 插件装载', () => {
  it('注册 enter/exit_plan_mode 两个工具，并以 sph-plan 为名提供服务', () => {
    const h = harness();
    setup(h.api);
    assert.deepEqual(h.tools.map((tool) => tool.name).sort(), ['enter_plan_mode', 'exit_plan_mode']);
    assert.ok(h.services.has(PLAN_MODE_SERVICE), '应提供 sph-plan 服务');
  });

  it('只覆盖子代理：只读定义放行，会写和未知按拦截，其余工具交给 planSafe', () => {
    const s = seam({
      find(name) {
        if (name === 'explore') return { writes: false };
        if (name === 'general') return { writes: true };
        return undefined;
      },
    });
    assert.equal(s.isBlocked('write', {}), undefined, '普通工具不覆盖，由 planSafe 决定');
    assert.equal(s.isBlocked('read', {}), undefined);
    assert.equal(s.isBlocked('subagent', { agent: 'explore' }), false, '只读子代理放行');
    assert.equal(s.isBlocked('subagent', { agent: 'general' }), true, '会写的子代理拦截');
    assert.equal(s.isBlocked('subagent', {}), true, '省略 agent 时按 general，会写');
    assert.equal(s.isBlocked('subagent', { agent: 'missing' }), true, '未知定义按会写');
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

describe('sph-plan 插件缺席语义', () => {
  it('服务不在时，核心的拦截点取不到 seam——plan mode 无法进入也就不需要拦截', () => {
    assert.equal(EMPTY_PLUGIN_SERVICES.get(PLAN_MODE_SERVICE), undefined);
  });
});
