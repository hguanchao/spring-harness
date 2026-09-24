import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, loadConfig } from '../../src/config/load.js';

const dirs: string[] = [];

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const MINIMAL_REGISTRY = {
  providers: {
    main: {
      baseUrl: 'https://api.example.com/v1',
      api: 'chat-completions',
      apiKey: 'k',
      models: [{ id: 'm', contextWindow: 100_000 }],
    },
  },
};

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sph-config-'));
  dirs.push(dir);
  return dir;
}

/** 写一份最小可启动的 models.json + config.toml，各自追加待测内容。 */
function setup(registryExtra: object = {}, configExtra = ''): { registryPath: string; configPath: string } {
  const dir = tempDir();
  const registryPath = join(dir, 'models.json');
  const registry = {
    providers: {
      main: {
        baseUrl: 'https://api.example.com/v1',
        api: 'chat-completions',
        apiKey: 'k',
        models: [{ id: 'm', contextWindow: 100_000 }],
        ...registryExtra,
      },
    },
  };
  writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf8');
  const configPath = join(dir, 'config.toml');
  // 追加段自带 provider/model 键时省略默认行，避免 TOML 重复键。
  const defaults = [
    /^provider\s*=/m.test(configExtra) ? null : 'provider = "main"',
    /^model\s*=/m.test(configExtra) ? null : 'model = "m"',
  ].filter((line): line is string => line !== null);
  writeFileSync(configPath, [...defaults, configExtra, ''].join('\n'), 'utf8');
  return { registryPath, configPath };
}

describe('沙箱默认', () => {
  it('未写 sandbox 时关闭', () => {
    const { registryPath, configPath } = setup();
    assert.equal(loadConfig({ configPath, registryPath, env: {} }).sandbox, 'off');
  });
});

describe('启动校验', () => {
  it('缺 provider 拒绝启动', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'models.json'), JSON.stringify(MINIMAL_REGISTRY), 'utf8');
    assert.throws(
      () => loadConfig({ configPath: join(dir, 'config.toml'), registryPath: join(dir, 'models.json'), env: {} }),
      /provider must be a non-empty string/,
    );
  });

  it('指向不存在的 provider 时列出可选名字', () => {
    const { registryPath, configPath } = setup({}, 'provider = "nope"');
    assert.throws(
      () => loadConfig({ configPath, registryPath, env: {} }),
      /unknown provider "nope"[\s\S]*models.json has: main/,
    );
  });

  it('provider 既没有 apiKey 也没有 headers 时拒绝启动', () => {
    const { registryPath, configPath } = setup({ apiKey: '' });
    assert.throws(
      () => loadConfig({ configPath, registryPath, env: {} }),
      /no apiKey and no headers/,
    );
  });

  it('显式空 apiKey 配上 headers 可以启动（免鉴权网关）', () => {
    const { registryPath, configPath } = setup({ apiKey: '', headers: { 'X-Session': 'sph' } });
    const config = loadConfig({ configPath, registryPath, env: {} });
    assert.equal(config.apiKey, '');
    assert.equal(config.httpHeaders['X-Session'], 'sph');
  });

  it('models.json 缺失时报错并给出路径', () => {
    const dir = tempDir();
    assert.throws(
      () => loadConfig({ configPath: join(dir, 'config.toml'), registryPath: join(dir, 'models.json'), env: {} }),
      /models.json not found/,
    );
  });

  it('仅有 url 的 MCP 条目不挡启动', () => {
    const { registryPath, configPath } = setup({}, '[mcp_servers.remote]\ntype = "http"\nurl = "https://example.com/mcp"');
    const config = loadConfig({ configPath, registryPath, env: {} });
    assert.equal(config.mcpServers[0]?.name, 'remote');
    assert.equal(config.mcpServers[0]?.url, 'https://example.com/mcp');
    assert.equal(config.mcpServers[0]?.transport, 'http');
    assert.equal(config.mcpServers[0]?.title, undefined);
  });

  it('表内 name 记成显示名，表头仍是 ID', () => {
    const { registryPath, configPath } = setup(
      {},
      '[mcp_servers.tavily]\nname = "Tavily"\ntype = "stdio"\ncommand = "npx"',
    );
    const server = loadConfig({ configPath, registryPath, env: {} }).mcpServers[0];
    assert.equal(server?.name, 'tavily');
    assert.equal(server?.title, 'Tavily');
  });

  it('数组形态的 mcp_servers 拒绝启动', () => {
    const { registryPath, configPath } = setup({}, '[[mcp_servers]]\nname = "remote"\nurl = "https://example.com/mcp"');
    assert.throws(
      () => loadConfig({ configPath, registryPath, env: {} }),
      /mcp_servers must be a table of tables/,
    );
  });

  it('端点字段来自 provider 声明，而不是 config.toml', () => {
    const { registryPath, configPath } = setup(
      { baseUrl: 'https://real.example.com/v1', api: 'responses' },
      'base_url = "https://ignored.example.com/v1"\napi = "chat-completions"',
    );
    const config = loadConfig({ configPath, registryPath, env: {} });
    assert.equal(config.baseUrl, 'https://real.example.com/v1', 'config.toml 里的 base_url 是死键，不生效');
    assert.equal(config.api, 'responses');
  });
});

describe('context_window 与 max_tokens 兜底', () => {
  it('模型声明的 contextWindow 优先于全局兜底', () => {
    const { registryPath, configPath } = setup({}, 'context_window = 500000');
    assert.equal(loadConfig({ configPath, registryPath, env: {} }).contextWindow, 100_000);
  });

  it('模型未声明时用全局兜底', () => {
    const { registryPath, configPath } = setup({ models: [{ id: 'm' }] }, 'context_window = 500000');
    assert.equal(loadConfig({ configPath, registryPath, env: {} }).contextWindow, 500_000);
  });

  it('两者都没有时用内置默认 256000', () => {
    const { registryPath, configPath } = setup({ models: [{ id: 'm' }] });
    assert.equal(loadConfig({ configPath, registryPath, env: {} }).contextWindow, 256_000);
  });

  it('模型声明的 maxTokens 优先于配置', () => {
    const { registryPath, configPath } = setup({ models: [{ id: 'm', maxTokens: 32768 }] }, 'max_tokens = 8192');
    assert.equal(loadConfig({ configPath, registryPath, env: {} }).maxTokens, 32768);
  });
});

describe('[permissions] 规则与 subagent_approval', () => {
  it('缺省时没有规则，子代理策略是 inherit', () => {
    const { registryPath, configPath } = setup();
    const config = loadConfig({ configPath, registryPath, env: {} });
    assert.deepEqual(config.permissions, { allow: [], ask: [], deny: [] });
    assert.equal(config.subagentApproval, 'inherit');
  });

  it('三张表原样读入，条目去掉首尾空白', () => {
    const { registryPath, configPath } = setup(
      {},
      '[permissions]\nallow = [" bash:npm test "]\nask = ["bash:git push*"]\ndeny = ["bash:rm -rf*"]',
    );
    const config = loadConfig({ configPath, registryPath, env: {} });
    assert.deepEqual(config.permissions.allow, ['bash:npm test']);
    assert.deepEqual(config.permissions.ask, ['bash:git push*']);
    assert.deepEqual(config.permissions.deny, ['bash:rm -rf*']);
  });

  it('未知键、非数组、空条目都拒绝启动', () => {
    const { registryPath, configPath } = setup({}, '[permissions]\nallows = ["x"]');
    assert.throws(() => loadConfig({ configPath, registryPath, env: {} }), /unknown permissions key/);
    const bad = setup({}, '[permissions]\ndeny = "bash:rm"');
    assert.throws(() => loadConfig({ configPath: bad.configPath, registryPath: bad.registryPath, env: {} }), /must be an array/);
    const empty = setup({}, '[permissions]\ndeny = ["  "]');
    assert.throws(() => loadConfig({ configPath: empty.configPath, registryPath: empty.registryPath, env: {} }), /non-empty string/);
  });

  it('subagent_approval 只认 inherit / strict', () => {
    const { registryPath, configPath } = setup({}, 'subagent_approval = "strict"');
    assert.equal(loadConfig({ configPath, registryPath, env: {} }).subagentApproval, 'strict');
    const bad = setup({}, 'subagent_approval = "never"');
    assert.throws(() => loadConfig({ configPath: bad.configPath, registryPath: bad.registryPath, env: {} }), /subagent_approval must be one of/);
  });
});

describe('[aux] 辅助端点', () => {
  it('未配置时 undefined，即与主端点同源', () => {
    const { registryPath, configPath } = setup();
    assert.equal(loadConfig({ configPath, registryPath, env: {} }).aux, undefined);
  });

  it('provider 指向已声明的另一个 provider', () => {
    const dir = tempDir();
    const registryPath = join(dir, 'models.json');
    writeFileSync(
      registryPath,
      JSON.stringify({
        providers: {
          main: { baseUrl: 'https://main.example.com/v1', api: 'chat-completions', apiKey: 'k', models: [{ id: 'm' }] },
          cheap: { baseUrl: 'https://cheap.example.com/v1', api: 'anthropic-messages', apiKey: 'k2', models: [{ id: 'cheap-m' }] },
        },
      }),
      'utf8',
    );
    const configPath = join(dir, 'config.toml');
    writeFileSync(configPath, 'provider = "main"\nmodel = "m"\n[aux]\nprovider = "cheap"\n', 'utf8');
    const config = loadConfig({ configPath, registryPath, env: {} });
    assert.equal(config.aux?.provider, 'cheap');
  });

  it('aux 不是表时报错', () => {
    const { registryPath, configPath } = setup({}, 'aux = "x"');
    assert.throws(() => loadConfig({ configPath, registryPath, env: {} }), ConfigError);
  });
});

describe('prompt_cache', () => {
  it('未配置时默认开：agent 多步循环里缓存收益远大于写入成本', () => {
    const { registryPath, configPath } = setup();
    assert.equal(loadConfig({ configPath, registryPath, env: {} }).promptCache, true);
  });

  it('显式 false 时关掉', () => {
    const { registryPath, configPath } = setup({}, 'prompt_cache = false');
    assert.equal(loadConfig({ configPath, registryPath, env: {} }).promptCache, false);
  });

  it('非布尔值拒绝启动，而不是静默当成 true', () => {
    const { registryPath, configPath } = setup({}, 'prompt_cache = "yes"');
    assert.throws(() => loadConfig({ configPath, registryPath, env: {} }), ConfigError);
  });
});

describe('max_session_tokens', () => {
  it('未配置时默认 0（不限制）', () => {
    const { registryPath, configPath } = setup();
    assert.equal(loadConfig({ configPath, registryPath, env: {} }).maxSessionTokens, 0);
  });

  it('接受非负整数', () => {
    const { registryPath, configPath } = setup({}, 'max_session_tokens = 500000');
    assert.equal(loadConfig({ configPath, registryPath, env: {} }).maxSessionTokens, 500_000);
  });

  it('负数拒绝启动', () => {
    const { registryPath, configPath } = setup({}, 'max_session_tokens = -1');
    assert.throws(() => loadConfig({ configPath, registryPath, env: {} }), ConfigError);
  });
});

describe('max_turns', () => {
  it('未配置时不限制', () => {
    const { registryPath, configPath } = setup();
    assert.equal(loadConfig({ configPath, registryPath, env: {} }).maxTurns, undefined);
  });

  it('接受正整数', () => {
    const { registryPath, configPath } = setup({}, 'max_turns = 32');
    assert.equal(loadConfig({ configPath, registryPath, env: {} }).maxTurns, 32);
  });

  it('0 与负数拒绝启动', () => {
    for (const line of ['max_turns = 0', 'max_turns = -1']) {
      const { registryPath, configPath } = setup({}, line);
      assert.throws(() => loadConfig({ configPath, registryPath, env: {} }), ConfigError);
    }
  });
});

describe('max_retries', () => {
  it('未配置时默认 10', () => {
    const { registryPath, configPath } = setup();
    assert.equal(loadConfig({ configPath, registryPath, env: {} }).maxRetries, 10);
  });

  it('接受非负整数，0 表示失败即停', () => {
    const a = setup({}, 'max_retries = 3');
    assert.equal(loadConfig({ configPath: a.configPath, registryPath: a.registryPath, env: {} }).maxRetries, 3);
    const b = setup({}, 'max_retries = 0');
    assert.equal(loadConfig({ configPath: b.configPath, registryPath: b.registryPath, env: {} }).maxRetries, 0);
  });

  it('负数拒绝启动', () => {
    const { registryPath, configPath } = setup({}, 'max_retries = -1');
    assert.throws(() => loadConfig({ configPath, registryPath, env: {} }), ConfigError);
  });
});
