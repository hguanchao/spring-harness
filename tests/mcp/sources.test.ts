import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { discoverMcpServers, externalSourcePaths, type DiscoverOptions, type McpDiscovery } from '../../src/plugins/sph-mcp/sources.js';
import { testHostFacts } from '../plugins/host-fixture.js';

interface Scaffold {
  root: string;
  nested: string;
  home: string;
  sphHome: string;
  write(rel: string, text: string): void;
  options(overrides?: Partial<DiscoverOptions>): DiscoverOptions;
  cleanup(): void;
}

function scaffold(): Scaffold {
  const root = mkdtempSync(join(tmpdir(), 'sph-mcp-root-'));
  const nested = join(root, 'packages', 'app');
  const home = mkdtempSync(join(tmpdir(), 'sph-mcp-home-'));
  const sphHome = mkdtempSync(join(tmpdir(), 'sph-mcp-sph-'));
  mkdirSync(nested, { recursive: true });
  // 未信任会拦掉项目级来源，多数用例都在验证合并规则，所以默认信任；
  // 信任门本身有专门的用例。
  const options = (overrides: Partial<DiscoverOptions> = {}): DiscoverOptions => ({
    workspaceRoot: root,
    host: testHostFacts(),
    fromDir: root,
    home,
    sphHomeDir: sphHome,
    env: {},
    trusted: true,
    ...overrides,
  });
  return {
    root,
    nested,
    home,
    sphHome,
    write(rel, text) {
      const path = join(root, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text, 'utf8');
    },
    options,
    cleanup() {
      for (const dir of [root, home, sphHome]) rmSync(dir, { recursive: true, force: true });
    },
  };
}

function byName(discovery: McpDiscovery): Map<string, McpDiscovery['servers'][number]> {
  return new Map(discovery.servers.map((server) => [server.name, server]));
}

function sphConfig(...servers: Array<{ name: string; command: string }>): string {
  return servers
    .map((server) => `[mcp_servers.${server.name}]\ntype = "stdio"\ncommand = "${server.command}"\n`)
    .join('\n');
}

describe('discoverMcpServers 来源优先级', () => {
  it('sph 自身高于外部配置，外部配置高于 .mcp.json，同名整条替换', () => {
    const s = scaffold();
    try {
      s.write('.mcp.json', JSON.stringify({ mcpServers: { shared: { command: 'from-mcp-json' } } }));
      write(join(s.home, '.codex', 'config.toml'), '[mcp_servers.shared]\ncommand = "from-codex"\n');
      write(join(s.home, '.claude.json'), JSON.stringify({ mcpServers: { shared: { command: 'from-claude' } } }));
      write(join(s.sphHome, 'config.toml'), sphConfig({ name: 'shared', command: 'from-sph' }));

      const found = byName(discoverMcpServers(s.options()));
      assert.equal(found.get('shared')?.command, 'from-sph');
      assert.equal(found.get('shared')?.kind, 'sph');
    } finally {
      s.cleanup();
    }
  });

  it('去掉最高优先级后依次落到下一层，顺序确实是阶梯', () => {
    const s = scaffold();
    try {
      s.write('.mcp.json', JSON.stringify({ mcpServers: { shared: { command: 'from-mcp-json' } } }));
      write(join(s.home, '.codex', 'config.toml'), '[mcp_servers.shared]\ncommand = "from-codex"\n');
      write(join(s.home, '.claude.json'), JSON.stringify({ mcpServers: { shared: { command: 'from-claude' } } }));

      assert.equal(byName(discoverMcpServers(s.options())).get('shared')?.command, 'from-claude');

      rmSync(join(s.home, '.claude.json'));
      assert.equal(byName(discoverMcpServers(s.options())).get('shared')?.command, 'from-codex');

      rmSync(join(s.home, '.codex', 'config.toml'));
      assert.equal(byName(discoverMcpServers(s.options())).get('shared')?.command, 'from-mcp-json');
    } finally {
      s.cleanup();
    }
  });

  it('项目级 sph 配置压过用户级，且越近的目录越优先', () => {
    const s = scaffold();
    try {
      write(join(s.sphHome, 'config.toml'), sphConfig({ name: 'shared', command: 'user' }));
      s.write('.sph/config.toml', sphConfig({ name: 'shared', command: 'repo-root' }));
      s.write('packages/app/.sph/config.toml', sphConfig({ name: 'shared', command: 'nested' }));

      assert.equal(byName(discoverMcpServers(s.options())).get('shared')?.command, 'repo-root');
      assert.equal(
        byName(discoverMcpServers(s.options({ fromDir: s.nested }))).get('shared')?.command,
        'nested',
        '从子目录启动时，最近的 .sph/config.toml 应当赢',
      );
    } finally {
      s.cleanup();
    }
  });

  it('.mcp.json 同样按「越近越优先」', () => {
    const s = scaffold();
    try {
      s.write('.mcp.json', JSON.stringify({ mcpServers: { shared: { command: 'root' } } }));
      s.write('packages/app/.mcp.json', JSON.stringify({ mcpServers: { shared: { command: 'nested' } } }));

      assert.equal(byName(discoverMcpServers(s.options({ fromDir: s.nested }))).get('shared')?.command, 'nested');
    } finally {
      s.cleanup();
    }
  });

  it('不同名字的多来源条目全部保留，各自带来源标签', () => {
    const s = scaffold();
    try {
      s.write('.mcp.json', JSON.stringify({ mcpServers: { a: { command: 'a' } } }));
      write(join(s.home, '.claude.json'), JSON.stringify({ mcpServers: { b: { command: 'b' } } }));
      write(join(s.sphHome, 'config.toml'), sphConfig({ name: 'c', command: 'c' }));

      const found = byName(discoverMcpServers(s.options()));
      assert.deepEqual([...found.keys()].sort(), ['a', 'b', 'c']);
      assert.equal(found.get('a')?.kind, 'mcp-json');
      assert.equal(found.get('b')?.origin.label, '~/.claude.json');
      assert.equal(found.get('c')?.origin.editable, true, 'sph 自己的文件可以就地改写');
      assert.equal(found.get('b')?.origin.editable, false, '外部文件只读');
    } finally {
      s.cleanup();
    }
  });
});

describe('discoverMcpServers 特殊字段', () => {
  it('sph 自己的配置按 [mcp_servers.<name>] 读取 type', () => {
    const s = scaffold();
    try {
      writeFileSync(join(s.sphHome, 'config.toml'), [
        '[mcp_servers.context7]',
        'type = "stdio"',
        'command = "npx"',
        'args = ["-y", "@upstash/context7-mcp"]',
        '',
      ].join('\n'), 'utf8');
      const server = byName(discoverMcpServers(s.options())).get('context7');
      assert.equal(server?.command, 'npx');
      assert.deepEqual(server?.args, ['-y', '@upstash/context7-mcp']);
      assert.equal(server?.transport, 'stdio');
      assert.equal(server?.title, undefined);
    } finally {
      s.cleanup();
    }
  });

  it('表内 name 是显示名，表头仍是 ID', () => {
    const s = scaffold();
    try {
      writeFileSync(join(s.sphHome, 'config.toml'), [
        '[mcp_servers.tavily]',
        'name = "Tavily"',
        'type = "stdio"',
        'command = "npx"',
        'args = ["-y", "tavily-mcp"]',
        '',
      ].join('\n'), 'utf8');
      const server = byName(discoverMcpServers(s.options())).get('tavily');
      assert.equal(server?.name, 'tavily');
      assert.equal(server?.title, 'Tavily');
      assert.equal(server?.command, 'npx');
    } finally {
      s.cleanup();
    }
  });

  it('HTTP 条目被发现并带上 url，而不是在读取时被静默丢掉', () => {
    const s = scaffold();
    try {
      s.write('.mcp.json', JSON.stringify({ mcpServers: { remote: { url: 'https://mcp.example.com/mcp' } } }));
      const server = byName(discoverMcpServers(s.options())).get('remote');
      assert.equal(server?.url, 'https://mcp.example.com/mcp');
      assert.equal(server?.command, undefined);
      assert.equal(server?.transport, undefined);
    } finally {
      s.cleanup();
    }
  });

  it('call_timeout_ms 被收下；非法值降级成警告，条目保留', () => {
    const s = scaffold();
    try {
      writeFileSync(join(s.sphHome, 'config.toml'), [
        '[mcp_servers.browser]',
        'command = "npx"',
        'call_timeout_ms = 120_000',
        '',
        '[mcp_servers.bad]',
        'command = "npx"',
        'call_timeout_ms = "soon"',
        '',
      ].join('\n'), 'utf8');
      const discovery = discoverMcpServers(s.options());
      const byId = byName(discovery);
      assert.equal(byId.get('browser')?.callTimeoutMs, 120_000);
      assert.equal(byId.get('bad')?.callTimeoutMs, undefined, '坏字段忽略，条目不丢');
      assert.equal(byId.get('bad')?.command, 'npx');
      assert.equal(discovery.warnings.some((w) => /call_timeout_ms must be a positive number/.test(w)), true);
    } finally {
      s.cleanup();
    }
  });

  it('JSON 里的 type 与 headers 被收下', () => {
    const s = scaffold();
    try {
      s.write('.mcp.json', JSON.stringify({
        mcpServers: {
          linear: { type: 'sse', url: 'https://mcp.linear.app/sse', headers: { Authorization: 'Bearer t' } },
          sentry: { type: 'streamable-http', url: 'https://mcp.sentry.dev/mcp' },
        },
      }));
      const found = byName(discoverMcpServers(s.options()));
      assert.equal(found.get('linear')?.transport, 'sse');
      assert.equal(found.get('linear')?.headers?.Authorization, 'Bearer t');
      assert.equal(found.get('sentry')?.transport, 'http');
    } finally {
      s.cleanup();
    }
  });

  it('disabled 与 enabled 都折算成启用态', () => {
    const s = scaffold();
    try {
      write(
        join(s.home, '.claude.json'),
        JSON.stringify({ mcpServers: { off: { command: 'x', disabled: true }, on: { command: 'y' } } }),
      );
      write(
        join(s.home, '.codex', 'config.toml'),
        '[mcp_servers.off2]\ncommand = "x"\nenabled = false\n\n[mcp_servers.on2]\ncommand = "y"\n',
      );

      const found = byName(discoverMcpServers(s.options()));
      assert.equal(found.get('off')?.enabled, false);
      assert.equal(found.get('on')?.enabled, true);
      assert.equal(found.get('off2')?.enabled, false);
      assert.equal(found.get('on2')?.enabled, true);
    } finally {
      s.cleanup();
    }
  });

  it('env_vars 就地展开成具体值，而不是留一个「继承」标记', () => {
    // sph 的 spawn 只吃一张现成的环境表；把继承留到 spawn 时会让命令签名的比较也变复杂。
    const s = scaffold();
    try {
      write(
        join(s.home, '.codex', 'config.toml'),
        [
          '[mcp_servers.routed]',
          'command = "relay"',
          'env = { STATIC = "1" }',
          'env_vars = ["FROM_PARENT", "ABSENT"]',
          '',
        ].join('\n'),
      );
      const server = byName(discoverMcpServers(s.options({ env: { FROM_PARENT: 'inherited' } }))).get('routed');
      assert.deepEqual(server?.env, { STATIC: '1', FROM_PARENT: 'inherited' });
    } finally {
      s.cleanup();
    }
  });

  it('projects 段按查找链读取，找不到精确 cwd 也能用仓库根那份', () => {
    const s = scaffold();
    try {
      write(
        join(s.home, '.claude.json'),
        JSON.stringify({
          mcpServers: { global: { command: 'g' } },
          projects: { [s.root]: { mcpServers: { local: { command: 'l' } } } },
        }),
      );
      const discovery = discoverMcpServers(s.options({ fromDir: s.nested }));
      const found = byName(discovery);
      assert.equal(found.get('global')?.kind, 'claude');
      assert.equal(found.get('local')?.kind, 'claude-project');
      assert.equal(found.get('global')?.projectRoot, undefined, '用户级条目没有落地工作区');
      assert.ok(found.get('local')?.projectRoot !== undefined, '项目级条目要记住自己的工作区');
    } finally {
      s.cleanup();
    }
  });
});

describe('discoverMcpServers 坏输入与信任门', () => {
  it('坏 JSON / 坏 TOML 降级成 invalid 报告 + 警告，不抛错也不炸启动', () => {
    const s = scaffold();
    try {
      s.write('.mcp.json', '{ not json');
      write(join(s.home, '.codex', 'config.toml'), '[[[broken');

      const discovery = discoverMcpServers(s.options());
      assert.deepEqual(discovery.servers, []);
      const invalid = discovery.reports.filter((report) => report.status === 'invalid');
      assert.equal(invalid.length, 2);
      assert.equal(discovery.warnings.length, 2);
    } finally {
      s.cleanup();
    }
  });

  it('外部配置里缺 command/url 的条目只报警告，不牵连同文件的其他条目', () => {
    const s = scaffold();
    try {
      s.write(
        '.mcp.json',
        JSON.stringify({ mcpServers: { good: { command: 'ok' }, bad: { args: ['--x'] } } }),
      );
      const discovery = discoverMcpServers(s.options());
      assert.deepEqual([...byName(discovery).keys()], ['good']);
      assert.ok(discovery.warnings.some((warning) => warning.includes('bad')));
    } finally {
      s.cleanup();
    }
  });

  it('未信任时丢弃项目级来源，但用户级照常保留', () => {
    const s = scaffold();
    try {
      s.write('.mcp.json', JSON.stringify({ mcpServers: { fromrepo: { command: 'x' } } }));
      s.write('.sph/config.toml', sphConfig({ name: 'repo-native', command: 'x' }));
      write(join(s.sphHome, 'config.toml'), sphConfig({ name: 'user', command: 'u' }));

      const found = byName(discoverMcpServers(s.options({ trusted: false })));
      assert.deepEqual([...found.keys()], ['user']);
    } finally {
      s.cleanup();
    }
  });

  it('未信任时，与项目声明同名的用户级条目也一并丢弃', () => {
    // 合并后只剩一份定义，但名字是唯一身份：用户删掉自己的全局条目后，项目的版本会
    // 静默接管这个名字。未信任的仓库不得影响这个名字最终 spawn 出什么命令。
    const s = scaffold();
    try {
      s.write('.mcp.json', JSON.stringify({ mcpServers: { shared: { command: 'evil' } } }));
      write(join(s.sphHome, 'config.toml'), sphConfig({ name: 'shared', command: 'mine' }));

      assert.deepEqual(byName(discoverMcpServers(s.options({ trusted: true }))).get('shared')?.command, 'mine');
      assert.equal(byName(discoverMcpServers(s.options({ trusted: false }))).has('shared'), false);
    } finally {
      s.cleanup();
    }
  });
});

describe('discoverMcpServers 本地偏好与导入标记', () => {
  it('disabled_servers 能关掉任何来源的条目，enabled_servers 能反过来打开', () => {
    const s = scaffold();
    try {
      s.write('.mcp.json', JSON.stringify({ mcpServers: { a: { command: 'a' }, b: { command: 'b', disabled: true } } }));

      const found = byName(
        discoverMcpServers(
          s.options({
            preferences: { disabledServers: ['a'], enabledServers: ['b'], lazyServers: [] },
          }),
        ),
      );
      assert.equal(found.get('a')?.enabled, false, '本地偏好要能盖过来源的默认启用');
      assert.equal(found.get('b')?.enabled, true, '也要能打开来源自己声明关掉的');
    } finally {
      s.cleanup();
    }
  });

  it('lazy_servers 偏好按名字叠加到任意来源的条目上', () => {
    const s = scaffold();
    try {
      s.write('.mcp.json', JSON.stringify({ mcpServers: { heavy: { command: 'npx' }, light: { command: 'node' } } }));

      const found = byName(
        discoverMcpServers(
          s.options({
            preferences: { disabledServers: [], enabledServers: [], lazyServers: ['heavy'] },
          }),
        ),
      );
      assert.equal(found.get('heavy')?.lazy, true);
      assert.equal(found.get('light')?.lazy, false);
    } finally {
      s.cleanup();
    }
  });

  it('报告里能区分 found / empty / missing', () => {
    const s = scaffold();
    try {
      s.write('.mcp.json', JSON.stringify({ mcpServers: { a: { command: 'a' } } }));
      write(join(s.home, '.codex', 'config.toml'), 'model = "x"\n');

      const statuses = new Map(
        discoverMcpServers(s.options()).reports.map((report) => [report.path, report.status]),
      );
      assert.equal(statuses.get(join(s.root, '.mcp.json')), 'found');
      assert.equal(statuses.get(join(s.home, '.codex', 'config.toml')), 'empty');
      assert.equal(statuses.get(join(s.home, '.claude.json')), 'missing');
    } finally {
      s.cleanup();
    }
  });
});

describe('externalSourcePaths', () => {
  it('省略 home 时用的是系统主目录，不是 ~/.sph', () => {
    // 回归点：home 曾回退成 sphHomeDir(=~/.sph)，于是外部来源全都去找
    // `~/.sph/.claude.json` 这种不存在的路径——表现为「一个 server 都扫不到」，
    // 而报告里清一色 missing，很难联想到是默认值写错了。单元测试里因为每次都显式传
    // home，这个 bug 一直没暴露，是拿真实 ~/.codex/config.toml 跑才发现的。
    const s = scaffold();
    try {
      const paths = externalSourcePaths('user', { workspaceRoot: s.root, host: testHostFacts(), sphHomeDir: s.sphHome });
      assert.ok(paths.includes(join(homedir(), '.claude.json')));
      assert.ok(paths.includes(join(homedir(), '.codex', 'config.toml')));
      assert.equal(paths.some((path) => path.startsWith(s.sphHome)), false, '不该落在 ~/.sph 里');
    } finally {
      s.cleanup();
    }
  });

  it('发现流程同样把外部来源指向系统主目录', () => {
    const s = scaffold();
    try {
      // 刻意不传 home：走生产默认值。
      const discovery = discoverMcpServers({ workspaceRoot: s.root, host: testHostFacts(), fromDir: s.root, sphHomeDir: s.sphHome });
      const claude = discovery.reports.find((report) => report.path.endsWith('.claude.json'));
      assert.equal(claude?.path, join(homedir(), '.claude.json'));
    } finally {
      s.cleanup();
    }
  });

  it('两个 scope 都覆盖 .claude.json，因为它的 projects 段是项目级的', () => {
    const s = scaffold();
    try {
      const shared = join(s.home, '.claude.json');
      assert.ok(externalSourcePaths('user', s.options()).includes(shared));
      assert.ok(externalSourcePaths('project', s.options()).includes(shared));
    } finally {
      s.cleanup();
    }
  });

  it('项目级清单覆盖查找链上的每一层', () => {
    const s = scaffold();
    try {
      const paths = externalSourcePaths('project', s.options({ fromDir: s.nested }));
      assert.ok(paths.includes(join(s.root, '.mcp.json')));
      assert.ok(paths.includes(join(s.nested, '.mcp.json')));
    } finally {
      s.cleanup();
    }
  });
});

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}
