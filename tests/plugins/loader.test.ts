import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { discoverPlugins, type DiscoveredPlugins } from '../../src/plugins/loader.js';

const PLUGIN_SOURCE = 'export default function () {}\n';

/**
 * 一次性的插件目录布局。三个装载根各自独立，避免相互干扰。
 *
 * `dir` 写目录型插件（`<root>/<name>/index.ts`），`flat` 写裸文件插件
 * （`<root>/<name>.ts`）——内置根只认前者，第三方根两者都认。
 */
function scaffold(): {
  workspace: string;
  userRoot: string;
  bundledRoot: string;
  dir(root: string, name: string, source?: string): void;
  flat(root: string, name: string, source?: string, ext?: string): void;
  discover(overrides?: Partial<Parameters<typeof discoverPlugins>[0]>): DiscoveredPlugins;
  cleanup(): void;
} {
  const workspace = mkdtempSync(join(tmpdir(), 'sph-plugin-ws-'));
  const userRoot = mkdtempSync(join(tmpdir(), 'sph-plugin-user-'));
  const bundledRoot = mkdtempSync(join(tmpdir(), 'sph-plugin-bundled-'));
  const write = (root: string, rel: string, text: string): void => {
    const path = join(root, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text, 'utf8');
  };
  return {
    workspace,
    userRoot,
    bundledRoot,
    dir(root, name, source = PLUGIN_SOURCE) {
      write(root, join(name, 'index.ts'), source);
    },
    flat(root, name, source = PLUGIN_SOURCE, ext = '.ts') {
      write(root, `${name}${ext}`, source);
    },
    discover(overrides = {}) {
      return discoverPlugins({ workspaceRoot: workspace, userRoot, bundledRoot, ...overrides });
    },
    cleanup() {
      for (const dir of [workspace, userRoot, bundledRoot]) {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

function names(candidates: readonly { name: string }[]): string[] {
  return candidates.map((candidate) => candidate.name).sort();
}

describe('插件发现', () => {
  it('第三方根：单文件与目录（index.ts）两种形态都认', () => {
    const s = scaffold();
    try {
      s.flat(s.userRoot, 'flat');
      s.dir(s.userRoot, 'dird');
      assert.deepEqual(names(s.discover().candidates), ['dird', 'flat']);
    } finally {
      s.cleanup();
    }
  });

  it('第三方根：.js / .mjs 也认，非脚本文件忽略', () => {
    const s = scaffold();
    try {
      s.flat(s.userRoot, 'plain', PLUGIN_SOURCE, '.js');
      s.flat(s.userRoot, 'esm', PLUGIN_SOURCE, '.mjs');
      s.flat(s.userRoot, 'notes', '# not a plugin\n', '.md');
      s.flat(s.userRoot, 'README', 'nope\n', '');
      assert.deepEqual(names(s.discover().candidates), ['esm', 'plain']);
    } finally {
      s.cleanup();
    }
  });

  it('内置根只认目录：插件系统自己的模块不会被当插件', () => {
    const s = scaffold();
    try {
      // 内置根就是 src/plugins/，插件系统的模块与内置插件同住一处。
      s.flat(s.bundledRoot, 'loader');
      s.flat(s.bundledRoot, 'host');
      s.flat(s.bundledRoot, 'types', PLUGIN_SOURCE, '.js');
      s.dir(s.bundledRoot, 'real-plugin');
      assert.deepEqual(names(s.discover().candidates), ['real-plugin']);
    } finally {
      s.cleanup();
    }
  });

  it('package.json 的 sph.plugins 可声明多个入口；sph.name 覆盖目录名', () => {
    const s = scaffold();
    try {
      s.flat(s.userRoot, join('multi', 'a'));
      s.flat(s.userRoot, join('multi', 'b'));
      s.flat(
        s.userRoot,
        join('multi', 'package.json'),
        JSON.stringify({ name: 'multi-pkg', sph: { name: 'renamed', plugins: ['./a.ts', './b.ts'] } }),
        '',
      );
      const found = s.discover().candidates;
      // 目录被重命名不该改变插件身份：禁用列表按名字匹配，名字必须来自声明。
      // 一个插件两个入口 → 一条候选、两个入口文件（不是两条同名候选）。
      assert.deepEqual(names(found), ['renamed']);
      assert.equal(found[0]?.entries.length, 2);
      assert.equal(found[0]?.entries.every((entry) => entry.endsWith('.ts')), true);
    } finally {
      s.cleanup();
    }
  });

  it('声明的入口一个都不存在时回落到 index.ts', () => {
    const s = scaffold();
    try {
      s.flat(s.userRoot, join('fallback', 'package.json'), JSON.stringify({ sph: { plugins: ['./missing.ts'] } }), '');
      s.dir(s.userRoot, 'fallback');
      const found = s.discover().candidates;
      assert.deepEqual(names(found), ['fallback']);
      assert.equal(found[0]?.entries[0]?.endsWith('index.ts'), true);
    } finally {
      s.cleanup();
    }
  });

  it('只有往下一层，不递归', () => {
    const s = scaffold();
    try {
      s.flat(s.userRoot, join('outer', 'inner', 'deep'));
      assert.deepEqual(names(s.discover().candidates), []);
    } finally {
      s.cleanup();
    }
  });
});

describe('插件装载根的优先级与信任门', () => {
  it('同名时项目级赢过用户级与内置', () => {
    const s = scaffold();
    try {
      s.dir(s.bundledRoot, 'dup');
      s.dir(s.userRoot, 'dup');
      s.dir(join(s.workspace, '.sph', 'plugins'), 'dup');
      const found = s.discover({ trusted: true }).candidates;
      assert.equal(found.length, 1, '同名只保留最高优先级的一条');
      assert.equal(found[0]?.root, 'project');
    } finally {
      s.cleanup();
    }
  });

  it('顶掉内置插件时把名字报出来', () => {
    const s = scaffold();
    try {
      s.dir(s.bundledRoot, 'sph-mcp');
      s.dir(s.bundledRoot, 'untouched');
      s.dir(s.userRoot, 'sph-mcp');
      const result = s.discover();
      // 遮蔽合法（就地打补丁），但「内置的实现被换掉了」必须可见。
      assert.deepEqual(result.shadowed, ['sph-mcp']);
      assert.equal(result.candidates.find((c) => c.name === 'untouched')?.root, 'bundled');
    } finally {
      s.cleanup();
    }
  });

  it('没有遮蔽时 shadowed 为空', () => {
    const s = scaffold();
    try {
      s.dir(s.bundledRoot, 'sph-mcp');
      s.dir(s.userRoot, 'mine');
      assert.deepEqual(s.discover().shadowed, []);
    } finally {
      s.cleanup();
    }
  });

  it('未被信任的工作区：项目级整个丢弃，用户级与内置照常', () => {
    const s = scaffold();
    try {
      s.dir(s.bundledRoot, 'builtin');
      s.dir(s.userRoot, 'mine');
      s.dir(join(s.workspace, '.sph', 'plugins'), 'repo');
      const found = s.discover({ trusted: false }).candidates;
      // 仓库里的 .sph/plugins/*.ts 是会被执行的任意代码，而仓库内容是别人写的。
      assert.deepEqual(names(found), ['builtin', 'mine']);
      assert.equal(found.some((candidate) => candidate.root === 'project'), false);
    } finally {
      s.cleanup();
    }
  });

  it('信任未指定时按未信任处理（默认拒绝，不是默认放行）', () => {
    const s = scaffold();
    try {
      s.dir(join(s.workspace, '.sph', 'plugins'), 'repo');
      assert.deepEqual(names(s.discover().candidates), []);
    } finally {
      s.cleanup();
    }
  });

  it('项目级放在 <workspace>/.sph/plugins，而不是仓库根的 plugins/', () => {
    const s = scaffold();
    try {
      // 仓库根那个 `plugins/` 不再被读——它会和源码目录混淆，而它是每个项目各自带一份的东西。
      s.dir(s.workspace, 'at-repo-root');
      s.dir(join(s.workspace, '.sph', 'plugins'), 'under-dot-sph');
      assert.deepEqual(names(s.discover({ trusted: true }).candidates), ['under-dot-sph']);
    } finally {
      s.cleanup();
    }
  });

  it('disabled 列表按名字剔除', () => {
    const s = scaffold();
    try {
      s.dir(s.bundledRoot, 'keep');
      s.dir(s.bundledRoot, 'drop');
      assert.deepEqual(names(s.discover({ disabled: ['drop'] }).candidates), ['keep']);
    } finally {
      s.cleanup();
    }
  });

  it('装载根不存在不是错误', () => {
    const s = scaffold();
    try {
      const result = discoverPlugins({
        workspaceRoot: join(s.workspace, 'does-not-exist'),
        userRoot: join(s.userRoot, 'nope'),
        bundledRoot: join(s.bundledRoot, 'nope'),
      });
      assert.deepEqual(result.candidates, []);
      assert.deepEqual(result.shadowed, []);
    } finally {
      s.cleanup();
    }
  });
});

describe('内置插件确实随包发布', () => {
  it('默认内置根（src/plugins）能找到 sph-mcp', () => {
    // 不传 bundledRoot 走默认值：内置根就是 loader 自己所在的目录，源码树与 dist 两种
    // 布局下都成立，不需要任何路径推算。
    const found = discoverPlugins({
      workspaceRoot: process.cwd(),
      userRoot: join(tmpdir(), 'definitely-not-a-plugins-dir'),
    }).candidates;
    const foundNames = found.map((candidate) => candidate.name);
    assert.ok(foundNames.includes('sph-mcp'), `内置插件里应有 sph-mcp，实际: ${foundNames.join(',')}`);
    assert.equal(found.find((c) => c.name === 'sph-mcp')?.root, 'bundled');
  });

  it('内置根不会把插件系统自己的模块列成插件', () => {
    const found = discoverPlugins({
      workspaceRoot: process.cwd(),
      userRoot: join(tmpdir(), 'definitely-not-a-plugins-dir'),
    }).candidates;
    const foundNames = found.map((candidate) => candidate.name);
    for (const systemModule of ['loader', 'host', 'types', 'services']) {
      assert.equal(foundNames.includes(systemModule), false, `${systemModule} 不是插件`);
    }
  });
});
