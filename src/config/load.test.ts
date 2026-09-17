import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, loadConfig } from './load.js';

const dirs: string[] = [];

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** 写一份最小可启动的 config.toml，追加一段待测配置。 */
function configWith(extra: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sph-config-'));
  dirs.push(dir);
  const path = join(dir, 'config.toml');
  writeFileSync(
    path,
    ['base_url = "https://api.example.com/v1"', 'model = "m"', 'api_key = "k"', extra, ''].join('\n'),
    'utf8',
  );
  return path;
}

describe('启动校验', () => {
  it('缺 api_key 且没有 http_headers 时拒绝启动', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sph-config-'));
    dirs.push(dir);
    const path = join(dir, 'config.toml');
    writeFileSync(path, 'base_url = "https://api.example.com/v1"\nmodel = "m"\n', 'utf8');
    assert.throws(() => loadConfig({ configPath: path, env: {} }), /API key/);
  });

  it('仅有 url 的 MCP 条目不挡启动', () => {
    const config = loadConfig({
      configPath: configWith('[[mcp_servers]]\nname = "remote"\nurl = "https://example.com/mcp"\n'),
      env: {},
    });
    assert.equal(config.mcpServers[0]?.name, 'remote');
    assert.equal(config.mcpServers[0]?.url, 'https://example.com/mcp');
  });
});

describe('prompt_cache', () => {
  it('未配置时默认开：agent 多步循环里缓存收益远大于写入成本', () => {
    assert.equal(loadConfig({ configPath: configWith(''), env: {} }).promptCache, true);
  });

  it('显式 false 时关掉', () => {
    assert.equal(loadConfig({ configPath: configWith('prompt_cache = false'), env: {} }).promptCache, false);
  });

  it('非布尔值拒绝启动，而不是静默当成 true', () => {
    assert.throws(
      () => loadConfig({ configPath: configWith('prompt_cache = "yes"'), env: {} }),
      ConfigError,
    );
  });
});

describe('[compat]', () => {
  it('未配置时 undefined，走 URL 推断', () => {
    assert.equal(loadConfig({ configPath: configWith(''), env: {} }).compat, undefined);
  });

  it('只配部分字段，其余省略', () => {
    const config = loadConfig({
      configPath: configWith('[compat]\nprompt_cache_key = true\nstream_options = false\n'),
      env: {},
    });
    assert.equal(config.compat?.promptCacheKey, true);
    assert.equal(config.compat?.streamOptions, false);
    assert.equal(config.compat?.promptCacheRetention, undefined);
    assert.equal(config.compat?.sessionAffinity, undefined);
  });

  it('session_affinity 只接受 openai | openrouter | off', () => {
    const config = loadConfig({
      configPath: configWith('[compat]\nsession_affinity = "openrouter"\n'),
      env: {},
    });
    assert.equal(config.compat?.sessionAffinity, 'openrouter');
    assert.throws(
      () => loadConfig({ configPath: configWith('[compat]\nsession_affinity = "foo"\n'), env: {} }),
      ConfigError,
    );
  });

  it('空表等价于未配置', () => {
    assert.equal(loadConfig({ configPath: configWith('[compat]\n'), env: {} }).compat, undefined);
  });

  it('aux.compat 独立于主 [compat]', () => {
    const config = loadConfig({
      configPath: configWith(
        '[compat]\nprompt_cache_key = true\n[aux]\nbase_url = "https://aux.example.com/v1"\n[aux.compat]\nstream_options = false\n',
      ),
      env: {},
    });
    assert.equal(config.compat?.promptCacheKey, true);
    assert.equal(config.aux?.compat?.streamOptions, false);
    assert.equal(config.aux?.compat?.promptCacheKey, undefined);
  });
});

describe('[aux] 辅助端点', () => {
  it('未配置时 undefined，即复用主端点', () => {
    assert.equal(loadConfig({ configPath: configWith(''), env: {} }).aux, undefined);
  });

  it('只配部分字段，其余回退主配置', () => {
    const config = loadConfig({ configPath: configWith('[aux]\nbase_url = "https://aux.example.com/v1"'), env: {} });
    assert.equal(config.aux?.baseUrl, 'https://aux.example.com/v1');
    assert.equal(config.aux?.apiKey, undefined, 'undefined 表示回退主 key');
    assert.equal(config.aux?.api, undefined, 'undefined 表示跟随主协议（含 --api 覆盖）');
  });

  it('显式空 api_key 表示该端点免鉴权，与顶层同一套三态语义', () => {
    const config = loadConfig({ configPath: configWith('[aux]\napi_key = ""'), env: {} });
    assert.equal(config.aux?.apiKey, '');
  });

  it('api 只在显式给出时取值，不被默认回填成 chat-completions', () => {
    const config = loadConfig({ configPath: configWith('[aux]\napi = "anthropic-messages"'), env: {} });
    assert.equal(config.aux?.api, 'anthropic-messages');
  });

  it('非法 api 报错', () => {
    assert.throws(() => loadConfig({ configPath: configWith('[aux]\napi = "soap"'), env: {} }), ConfigError);
  });

  it('aux 不是表时报错', () => {
    assert.throws(() => loadConfig({ configPath: configWith('aux = "x"'), env: {} }), ConfigError);
  });
});

describe('max_session_tokens', () => {
  it('未配置时默认 0（不限制）', () => {
    assert.equal(loadConfig({ configPath: configWith(''), env: {} }).maxSessionTokens, 0);
  });

  it('接受非负整数', () => {
    assert.equal(loadConfig({ configPath: configWith('max_session_tokens = 500000'), env: {} }).maxSessionTokens, 500000);
  });

  it('负数拒绝启动', () => {
    assert.throws(
      () => loadConfig({ configPath: configWith('max_session_tokens = -1'), env: {} }),
      ConfigError,
    );
  });
});

describe('max_retries', () => {
  it('未配置时默认 10', () => {
    assert.equal(loadConfig({ configPath: configWith(''), env: {} }).maxRetries, 10);
  });

  it('接受非负整数，0 表示失败即停', () => {
    assert.equal(loadConfig({ configPath: configWith('max_retries = 3'), env: {} }).maxRetries, 3);
    assert.equal(loadConfig({ configPath: configWith('max_retries = 0'), env: {} }).maxRetries, 0);
  });

  it('负数拒绝启动', () => {
    assert.throws(
      () => loadConfig({ configPath: configWith('max_retries = -1'), env: {} }),
      ConfigError,
    );
  });
});
