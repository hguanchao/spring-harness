import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import setup from '../../src/plugins/sph-mcp/index.js';
import { MCP_SERVICE, type McpService } from '../../src/plugins/services.js';
import { EMPTY_PLUGIN_SERVICES, type PluginApi, type PluginHostFacts } from '../../src/plugins/types.js';
import type { ToolContext, ToolSpec } from '../../src/tools/types.js';

/**
 * 插件装载的假宿主。
 *
 * 直接调用插件的默认导出，而不是经过 `PluginHost` + 加载器：这一层要验的是**插件自己**
 * 注册了什么。装载器与宿主各有各的测试（tests/plugins/loader.test.ts、host.test.ts）。
 */
function harness(): {
  api: PluginApi;
  tools: ToolSpec[];
  services: Map<string, unknown>;
  disposers: Array<() => void>;
} {
  const tools: ToolSpec[] = [];
  const services = new Map<string, unknown>();
  const disposers: Array<() => void> = [];
  const host: PluginHostFacts = {
    sphHome: process.cwd(),
    // 不 spawn 任何东西的用例里，环境擦除无关紧要；真起子进程的用例在 tests/mcp/hub.test.ts。
    mergeChildEnv: (extra) => ({ ...(extra ?? {}) }),
    canonicalize: (p) => p,
    isWorkspaceTrusted: () => true,
  };
  const api: PluginApi = {
    name: 'sph-mcp',
    workspaceRoot: process.cwd(),
    configPath: 'config.toml',
    host,
    registerTool: (tool) => tools.push(tool),
    provide: (name, service) => services.set(name, service),
    consume: () => undefined,
    warn: () => {},
    clip: (text, limit = 32 * 1024) => (text.length <= limit ? text : text.slice(0, limit)),
    registerCommand: () => {},
    subscribe: () => {},
    onDispose: (fn) => disposers.push(fn),
    registerHook: () => {},
  };
  return { api, tools, services, disposers };
}

function loaded(): { api: PluginApi; tools: ToolSpec[]; services: Map<string, unknown>; disposers: Array<() => void> } {
  const h = harness();
  setup(h.api);
  return h;
}

function toolOf(tools: ToolSpec[]): ToolSpec {
  const tool = tools.find((item) => item.name === 'mcp');
  assert.ok(tool, '插件应注册 mcp 工具');
  return tool;
}

function ctx(approvals: string[] = []): ToolContext {
  return {
    workspaceRoot: process.cwd(),
    sandboxMode: 'off',
    skills: [],
    todos: {} as ToolContext['todos'],
    jobs: {} as ToolContext['jobs'],
    services: EMPTY_PLUGIN_SERVICES,
    runShell: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    approve: async (tool: string, detail: string) => {
      approvals.push(`${tool}|${detail}`);
      return true;
    },
    askUser: async () => '',
    noteMemoryTouch() {},
    spawnSubagent: async () => '',
    sendToSubagent: () => 'not_found',
  };
}

describe('sph-mcp 插件装载', () => {
  it('注册 mcp 工具并以 sph-mcp 为名提供服务', () => {
    const h = loaded();
    assert.deepEqual(h.tools.map((tool) => tool.name), ['mcp']);
    const service = h.services.get(MCP_SERVICE) as McpService;
    assert.ok(service, '应提供 sph-mcp 服务');
    // 宿主界面依赖这几个方法；缺一个都会让 /mcps 在运行时报 undefined is not a function。
    for (const method of ['reload', 'sources', 'warnings', 'listTools', 'listServers', 'listToolsOf', 'call', 'whenReady', 'dispose'] as const) {
      assert.equal(typeof service[method], 'function', `服务缺少 ${method}`);
    }
  });

  it('登记清理回调：MCP 子进程不能留成孤儿', () => {
    const h = loaded();
    assert.equal(h.disposers.length, 1);
    // 幂等且不抛错——退出路径上重复调用是常态（exit 与 SIGINT 都会走到）。
    for (const dispose of h.disposers) {
      assert.doesNotThrow(() => dispose());
      assert.doesNotThrow(() => dispose());
    }
  });

  it('未刷新前 sources/warnings 是空清单，不是 undefined', () => {
    const h = loaded();
    const service = h.services.get(MCP_SERVICE) as McpService;
    assert.deepEqual([...service.sources()], []);
    assert.deepEqual([...service.warnings()], []);
    assert.deepEqual(service.listServers(), []);
    assert.deepEqual(service.listTools(), []);
  });
});

describe('mcp 工具参数校验', () => {
  it('未知 action 报错指向 action，而不是 server 缺失', async () => {
    const result = await toolOf(loaded().tools).execute({ action: 'bogus' }, ctx());
    assert.equal(result.ok, false);
    assert.match(result.content, /unknown action: bogus/);
    assert.equal(/server is required/.test(result.content), false);
  });

  it('call 走审批，list 不走', async () => {
    const approvals: string[] = [];
    const tool = toolOf(loaded().tools);
    const c = ctx(approvals);
    // 假 hub 没连过任何 server，call 必然抛错——**审批必须先发生**才是这里要验的。
    // 工具不吞 hub 的错误：连不上是运行期事实，由 loop 统一成工具错误反馈给模型，
    // 在过去（工具在核心工具表里时）也是这个行为。
    await assert.rejects(
      () => tool.execute({ action: 'call', server: 's', tool: 't', arguments: {} }, c),
      /not connected/,
    );
    assert.deepEqual(approvals, ['mcp|s.t'], `实际: ${approvals.join(',')}`);
    approvals.length = 0;
    await tool.execute({ action: 'list' }, c);
    assert.deepEqual(approvals, [], 'list 是只读动作，不该走审批');
  });

  it('call 缺 server 或 tool 直接报缺失，不发审批', async () => {
    const approvals: string[] = [];
    const tool = toolOf(loaded().tools);
    await assert.rejects(
      () => tool.execute({ action: 'call', tool: 't' }, ctx(approvals)),
      /server is required/,
    );
    await assert.rejects(
      () => tool.execute({ action: 'call', server: 's' }, ctx(approvals)),
      /tool is required/,
    );
    assert.deepEqual(approvals, []);
  });
});
