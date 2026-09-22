import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PluginHost } from '../../src/plugins/host.js';
import { discoverPlugins } from '../../src/plugins/loader.js';
import type { ToolSpec } from '../../src/tools/types.js';

/** 一个最小的核心工具，用于检出插件与核心的重名。 */
const coreTool: ToolSpec = {
  name: 'read',
  description: 'stub',
  schema: { type: 'object', properties: {} },
  execute: async () => ({ ok: true, content: '' }),
};

function pluginSource(body: string): string {
  return `export default function (api) {\n${body}\n}\n`;
}

function scaffold(): { root: string; write(name: string, source: string): void; host(): PluginHost; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'sph-plugin-host-'));
  return {
    root,
    write(name, source) {
      writeFileSync(join(root, name), source, 'utf8');
    },
    host() {
      return new PluginHost({ coreTools: [coreTool], workspaceRoot: root, configPath: join(root, 'config.toml') });
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function loadInto(host: PluginHost, root: string): Promise<void> {
  // root 直接当**用户级**插件根：内置根与工作区根指向不存在的目录。本文件验的是装载行为
  // （注册、错误隔离、清理），发现优先级与信任门是 loader.test.ts 的事。
  const discovered = discoverPlugins({
    workspaceRoot: join(root, 'no-such-workspace'),
    userRoot: root,
    bundledRoot: join(root, 'no-such-bundled'),
  });
  await host.load(discovered.candidates);
}

describe('插件宿主：注册与合成', () => {
  it('插件工具进最终工具表，核心工具保留', async () => {
    const s = scaffold();
    try {
      s.write('extra.ts', pluginSource(`  api.registerTool({ name: 'extra', description: 'd', schema: {}, execute: async () => ({ ok: true, content: '' }) });`));
      const host = s.host();
      await loadInto(host, s.root);
      const registry = host.tools();
      assert.deepEqual(registry.list().map((tool) => tool.name).sort(), ['extra', 'read']);
    } finally {
      s.cleanup();
    }
  });

  it('provide 的服务可取；未提供的取到 undefined', async () => {
    const s = scaffold();
    try {
      s.write('svc.ts', pluginSource(`  api.provide('thing', { value: 42 });`));
      const host = s.host();
      await loadInto(host, s.root);
      assert.deepEqual(host.get<{ value: number }>('thing'), { value: 42 });
      assert.equal(host.has('thing'), true);
      assert.equal(host.get('nope'), undefined);
      assert.equal(host.has('nope'), false);
      assert.deepEqual(host.names(), ['thing']);
    } finally {
      s.cleanup();
    }
  });

  it('后装的插件能 consume 先装的服务', async () => {
    const s = scaffold();
    try {
      s.write('a-first.ts', pluginSource(`  api.provide('first', 'hello');`));
      s.write('b-second.ts', pluginSource(`  const value = api.consume('first');\n  api.provide('second', value + ' world');`));
      const host = s.host();
      await loadInto(host, s.root);
      assert.equal(host.get('second'), 'hello world');
    } finally {
      s.cleanup();
    }
  });
});

describe('插件宿主：错误隔离', () => {
  it('语法/导入失败的插件被记成警告，其它插件照常装载', async () => {
    const s = scaffold();
    try {
      s.write('broken.ts', 'this is not valid typescript (((\n');
      s.write('good.ts', pluginSource(`  api.provide('ok', true);`));
      const host = s.host();
      await loadInto(host, s.root);
      assert.equal(host.get('ok'), true, '好插件不受坏插件影响');
      const warnings = host.warnings();
      assert.equal(warnings.length, 1);
      assert.match(warnings[0] ?? '', /plugin broken:/);
    } finally {
      s.cleanup();
    }
  });

  it('setup 抛错只影响该插件，且错误文本可见', async () => {
    const s = scaffold();
    try {
      s.write('throws.ts', pluginSource(`  throw new Error('setup exploded');`));
      s.write('fine.ts', pluginSource(`  api.provide('fine', 1);`));
      const host = s.host();
      await loadInto(host, s.root);
      assert.equal(host.get('fine'), 1);
      assert.match(host.warnings().join('\n'), /setup exploded/);
    } finally {
      s.cleanup();
    }
  });

  it('默认导出形态不对（不是函数也没有 setup）→ 警告而不是崩', async () => {
    const s = scaffold();
    try {
      s.write('weird.ts', 'export default { notAPlugin: true };\n');
      const host = s.host();
      await loadInto(host, s.root);
      assert.match(host.warnings().join('\n'), /must be a plugin factory function or an object with setup/);
    } finally {
      s.cleanup();
    }
  });

  it('工具与核心重名 → 拒绝并记警告，不会顶掉核心工具', async () => {
    const s = scaffold();
    try {
      s.write('clash.ts', pluginSource(`  api.registerTool({ name: 'read', description: 'd', schema: {}, execute: async () => ({ ok: true, content: '' }) });`));
      const host = s.host();
      await loadInto(host, s.root);
      assert.match(host.warnings().join('\n'), /tool "read" collides with a built-in tool/);
      // 核心那份仍在，且没有被插件的定义替换。
      assert.equal(host.tools().find('read')?.description, 'stub');
    } finally {
      s.cleanup();
    }
  });

  it('两个插件抢同一个工具名 → 后者被拒，先注册的保留', async () => {
    const s = scaffold();
    try {
      const body = `  api.registerTool({ name: 'dup', description: 'd', schema: {}, execute: async () => ({ ok: true, content: '' }) });`;
      s.write('a-one.ts', pluginSource(body));
      s.write('b-two.ts', pluginSource(body));
      const host = s.host();
      await loadInto(host, s.root);
      assert.equal(host.tools().list().filter((tool) => tool.name === 'dup').length, 1);
      assert.match(host.warnings().join('\n'), /tool "dup" collides with plugin/);
    } finally {
      s.cleanup();
    }
  });

  it('服务名重复 provide → 抛错转警告，先提供的保留', async () => {
    const s = scaffold();
    try {
      s.write('a-one.ts', pluginSource(`  api.provide('same', 'first');`));
      s.write('b-two.ts', pluginSource(`  api.provide('same', 'second');`));
      const host = s.host();
      await loadInto(host, s.root);
      assert.equal(host.get('same'), 'first');
      assert.match(host.warnings().join('\n'), /already provided by plugin/);
    } finally {
      s.cleanup();
    }
  });
});

describe('插件宿主：清理', () => {
  it('逆序清理（后装的先拆），幂等', async () => {
    const s = scaffold();
    try {
      s.write('a-one.ts', pluginSource(`  api.onDispose(() => api.consume('log').push('one'));\n  api.provide('log', globalThis.__sphOrder ??= []);`));
      s.write('b-two.ts', pluginSource(`  api.onDispose(() => api.consume('log').push('two'));`));
      const host = s.host();
      await loadInto(host, s.root);
      const order = (globalThis as Record<string, unknown>).__sphOrder as string[];
      order.length = 0;
      host.dispose();
      // 后装的插件可能依赖先装的服务，先拆后者才不会让前者在拆卸期拿到半死的依赖。
      assert.deepEqual(order, ['two', 'one']);
      host.dispose();
      assert.deepEqual(order, ['two', 'one'], 'dispose 幂等：重复调用不再触发回调');
    } finally {
      s.cleanup();
    }
  });

  it('单个清理回调抛错不影响其余回调', async () => {
    const s = scaffold();
    try {
      s.write('a-one.ts', pluginSource(`  api.onDispose(() => { throw new Error('dispose boom'); });`));
      s.write('b-two.ts', pluginSource(`  api.onDispose(() => api.consume('mark').push('two'));\n  api.provide('mark', globalThis.__sphMark ??= []);`));
      const host = s.host();
      await loadInto(host, s.root);
      const mark = (globalThis as Record<string, unknown>).__sphMark as string[];
      mark.length = 0;
      assert.doesNotThrow(() => host.dispose());
      assert.deepEqual(mark, ['two'], '另一个插件的清理仍要执行');
    } finally {
      s.cleanup();
    }
  });
});

describe('插件宿主：装载顺序', () => {
  it('导入阶段先于所有 setup：插件能看到全部条目，而不是取决于文件系统读入顺序', async () => {
    const s = scaffold();
    try {
      // a 提供，b 消费。若边导入边执行，b 能否看到 a 就取决于 readdir 顺序。
      s.write('a-provider.ts', pluginSource(`  api.provide('dep', 'ready');`));
      s.write('b-consumer.ts', pluginSource(`  api.provide('seen', api.consume('dep') ?? 'missing');`));
      const host = s.host();
      await loadInto(host, s.root);
      assert.equal(host.get('seen'), 'ready');
    } finally {
      s.cleanup();
    }
  });
});

describe('插件报告', () => {
  it('report() 给出每个插件的工具、服务与警告；failures 单独列出', async () => {
    const s = scaffold();
    try {
      s.write('one.ts', pluginSource(`  api.registerTool({ name: 't1', description: 'd', schema: {}, execute: async () => ({ ok: true, content: '' }) });\n  api.provide('s1', 1);\n  api.warn('heads up');`));
      s.write('bad.ts', 'export default 42;\n');
      const host = s.host();
      await loadInto(host, s.root);
      const report = host.report();
      const one = report.plugins.find((plugin) => plugin.name === 'one');
      assert.deepEqual(one?.tools, ['t1']);
      assert.deepEqual(one?.services, ['s1']);
      assert.deepEqual(one?.warnings, ['heads up']);
      assert.equal(one?.root, 'user');
      assert.deepEqual(report.failures.map((failure) => failure.name), []);
      // 形态错误是在 setup 阶段被判的，所以进 warnings 而不是 failures（failures 专指导入失败）。
      assert.match(host.warnings().join('\n'), /plugin bad:/);
    } finally {
      s.cleanup();
    }
  });
});
