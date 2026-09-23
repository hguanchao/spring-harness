import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import setup, { TodoList } from '../../src/plugins/sph-todo/index.js';
import { TODO_SERVICE, todoEventData, type TodoService } from '../../src/plugins/services.js';
import { EMPTY_PLUGIN_SERVICES, type PluginApi, type PluginHostFacts } from '../../src/plugins/types.js';
import type { ToolContext, ToolSpec } from '../../src/tools/types.js';

/** 直接调用插件默认导出：验插件自己注册了什么（装载器与宿主各有各的测试）。 */
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
    name: 'sph-todo',
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
    onDispose: () => {},
  };
  return { api, tools, services };
}

function ctx(): ToolContext {
  return {
    workspaceRoot: process.cwd(),
    sandboxMode: 'off',
    skills: [],
    todos: EMPTY_PLUGIN_SERVICES as unknown as ToolContext['todos'],
    jobs: {} as ToolContext['jobs'],
    services: EMPTY_PLUGIN_SERVICES,
    runShell: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    approve: async () => true,
    askUser: async () => '',
    noteMemoryTouch() {},
    spawnSubagent: async () => '',
    sendToSubagent: () => 'not_found',
  };
}

describe('todo 插件装载', () => {
  it('注册 todo 工具并以 todo 为名提供服务', () => {
    const h = harness();
    setup(h.api);
    assert.deepEqual(h.tools.map((tool) => tool.name), ['todo']);
    const service = h.services.get(TODO_SERVICE) as TodoService;
    assert.ok(service, '应提供 todo 服务');
    assert.equal(typeof service.replace, 'function');
    assert.equal(typeof service.list, 'function');
  });

  it('replace 是整表替换，list 返回副本（改返回值不影响内部）', () => {
    const list = new TodoList();
    const input = [
      { id: '1', content: 'a', status: 'pending' as const },
      { id: '2', content: 'b', status: 'in_progress' as const },
    ];
    list.replace(input);
    const read = list.list();
    read[0]!.content = 'mutated';
    assert.equal(list.list()[0]?.content, 'a', 'list 必须返回副本');
    list.replace([{ id: '1', content: 'only', status: 'completed' as const }]);
    assert.deepEqual(list.list().map((item) => item.id), ['1'], 'replace 是整体替换不是合并');
  });

  it('todoEventData 是整表快照，事件形状与折叠读取方一致', () => {
    const data = todoEventData([
      { id: '1', content: 'a', status: 'pending' },
    ]);
    assert.deepEqual(data.items, [{ id: '1', content: 'a', status: 'pending' }]);
  });
});

describe('todo 工具', () => {
  it('status 非法时报错指向具体条目', async () => {
    const h = harness();
    setup(h.api);
    const tool = h.tools[0]!;
    const c = ctx();
    // 先给一个合法的，让 service 可用
    const bad = { items: [{ id: '1', content: 'x', status: 'done' }] };
    await assert.rejects(() => tool.execute(bad, c), /items\[0\]\.status invalid/);
  });

  it('合法输入整体替换并回显', async () => {
    const h = harness();
    setup(h.api);
    const tool = h.tools[0]!;
    const c = ctx();
    // ctx.todos 在这里被当作 EMPTY——但工具实现用的是 ctx.todos.replace。
    // 为了让断言有意义，给 ctx 一个真 TodoList。
    const list = new TodoList();
    const c2 = { ...c, todos: list };
    const result = await tool.execute(
      { items: [{ id: 'a', content: 'first', status: 'pending' }] },
      c2,
    );
    assert.equal(result.ok, true);
    assert.match(result.content, /first/);
    assert.deepEqual(list.list().map((item) => item.id), ['a']);
  });
});
