import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendModelDeclaration,
  findProvider,
  interpolateEnv,
  loadRegistry,
  parseRegistry,
  resolveModel,
  splitProviderModel,
  upsertModelApi,
} from './registry.js';
import { ConfigError } from './errors.js';

const dirs: string[] = [];

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function registryFile(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sph-reg-'));
  dirs.push(dir);
  const path = join(dir, 'models.json');
  writeFileSync(path, text, 'utf8');
  return path;
}

const REGISTRY = {
  providers: {
    main: {
      baseUrl: 'https://api.example.com/v1',
      api: 'responses',
      apiKey: '$MAIN_KEY',
      headers: { 'User-Agent': 'sph/${SPH_SUFFIX}' },
      compat: { prompt_cache_key: true },
      models: [
        { id: 'glm', name: 'GLM Flash', contextWindow: 500_000, maxTokens: 8192 },
        { id: 'claude', api: 'anthropic-messages', compat: { stream_options: false } },
      ],
    },
    cheap: { baseUrl: 'https://cheap.example.com/v1', api: 'chat-completions', apiKey: 'k2', models: [{ id: 'ds' }] },
  },
};

const env = { MAIN_KEY: 'sk-main', SPH_SUFFIX: 'test' };

describe('parseRegistry', () => {
  it('provider 级 api 是模型级缺省；模型级覆盖它', () => {
    const registry = parseRegistry(REGISTRY, env);
    const main = findProvider(registry, 'main');
    assert.equal(resolveModel(main, 'glm').api, 'responses');
    assert.equal(resolveModel(main, 'claude').api, 'anthropic-messages');
  });

  it('$VAR 与 ${VAR} 插值进 apiKey 与 headers', () => {
    const main = parseRegistry(REGISTRY, env).providers[0]!;
    assert.equal(main.apiKey, 'sk-main');
    assert.equal(main.headers['User-Agent'], 'sph/test');
  });

  it('变量缺失时直接报错，不静默变成免鉴权', () => {
    assert.throws(
      () => parseRegistry(REGISTRY, {}),
      ConfigError,
    );
  });

  it('$$ 输出字面 $；裸 $ 原样保留', () => {
    assert.equal(interpolateEnv('$$sk-x', env), '$sk-x');
    assert.equal(interpolateEnv('a $ b', env), 'a $ b');
  });

  it('重复模型 id 报错', () => {
    assert.throws(
      () => parseRegistry({ providers: { p: { baseUrl: 'u', api: 'responses', models: [{ id: 'a' }, { id: 'a' }] } } }, {}),
      /declares model "a" twice/,
    );
  });

  it('provider 与模型级都没写 api 时报错', () => {
    assert.throws(
      () => parseRegistry({ providers: { p: { baseUrl: 'u', models: [{ id: 'a' }] } } }, {}),
      /needs "api" at provider or model level/,
    );
  });

  it('models 缺失或空都报错', () => {
    assert.throws(
      () => parseRegistry({ providers: { p: { baseUrl: 'u', api: 'responses' } } }, {}),
      /models must be an array/,
    );
    assert.throws(
      () => parseRegistry({ providers: { p: { baseUrl: 'u', api: 'responses', models: [] } } }, {}),
      /declares no models/,
    );
  });

  it('文件不存在报错并给出路径；JSON 坏掉也报错', () => {
    assert.throws(() => loadRegistry('/nonexistent/models.json', {}), /models.json not found/);
  });
});

describe('resolveModel 合并', () => {
  const main = parseRegistry(REGISTRY, env).providers[0]!;

  it('compat 逐键浅合并：模型级赢，provider 级其余键保留', () => {
    const resolved = resolveModel(main, 'claude');
    assert.equal(resolved.compat?.promptCacheKey, true, 'provider 级的键保留');
    assert.equal(resolved.compat?.streamOptions, false, '模型级覆盖');
  });

  it('--api 覆盖模型级与 provider 级', () => {
    assert.equal(resolveModel(main, 'glm', { apiOverride: 'chat-completions' }).api, 'chat-completions');
  });

  it('容量声明生效；未声明的模型回落 provider（无声明即 undefined）', () => {
    const glm = resolveModel(main, 'glm');
    assert.equal(glm.contextWindow, 500_000);
    assert.equal(glm.maxTokens, 8192);
    assert.equal(resolveModel(main, 'unlisted').contextWindow, undefined);
  });

  it('name 未声明时 undefined，调用方回落 displayNameForModel', () => {
    assert.equal(resolveModel(main, 'claude').name, undefined);
  });
});

describe('splitProviderModel 歧义', () => {
  const providers = parseRegistry(REGISTRY, env).providers;

  it('前缀命中 provider 名时按限定解析', () => {
    assert.deepEqual(splitProviderModel(providers, 'cheap/ds'), { provider: 'cheap', model: 'ds' });
  });

  it('前缀不是 provider 名时整串当模型 id（nvidia/xxx 的真实形态）', () => {
    assert.deepEqual(splitProviderModel(providers, 'nvidia/deepseek-v4'), { model: 'nvidia/deepseek-v4' });
  });

  it('无斜杠时就是模型 id', () => {
    assert.deepEqual(splitProviderModel(providers, 'glm'), { model: 'glm' });
  });
});

describe('appendModelDeclaration', () => {
  const BASE = JSON.stringify({
    providers: {
      main: { baseUrl: 'https://api.example.com/v1', api: 'responses', apiKey: '$MAIN_KEY', models: [{ id: 'glm' }] },
    },
  });

  it('追加未声明的模型，能被 loadRegistry 读回', () => {
    const path = registryFile(BASE);
    appendModelDeclaration(path, 'main', 'new-model', { contextWindow: 128_000 });
    const registry = loadRegistry(path, env);
    const main = findProvider(registry, 'main');
    assert.ok(main.models.some((row) => row.id === 'new-model' && row.contextWindow === 128_000));
    assert.ok(main.models.some((row) => row.id === 'glm'), '已有声明保留');
  });

  it('id 已存在时不写文件', () => {
    const path = registryFile(BASE);
    const before = readFileSync(path, 'utf8');
    appendModelDeclaration(path, 'main', 'glm');
    assert.equal(readFileSync(path, 'utf8'), before, '重复声明不动文件');
  });

  it('$VAR 原样保留：追加不把插值烙成真实值', () => {
    const path = registryFile(BASE);
    appendModelDeclaration(path, 'main', 'new-model');
    const text = readFileSync(path, 'utf8');
    assert.match(text, /\$MAIN_KEY/, 'apiKey 的插值引用必须原样写回');
  });

  it('未知 provider 或坏 JSON 直接报错', () => {
    const path = registryFile(BASE);
    assert.throws(() => appendModelDeclaration(path, 'nope', 'x'), /unknown provider/);
    assert.throws(() => appendModelDeclaration(registryFile('{ bad'), 'main', 'x'), /not valid JSON/);
  });
});

describe('upsertModelApi', () => {
  const BASE = JSON.stringify({
    providers: {
      main: { baseUrl: 'https://api.example.com/v1', api: 'responses', apiKey: '$MAIN_KEY', models: [{ id: 'glm' }] },
    },
  });

  it('已有模型改 api，未声明的追加', () => {
    const path = registryFile(BASE);
    upsertModelApi(path, 'main', 'glm', 'anthropic-messages');
    upsertModelApi(path, 'main', 'new-model', 'chat-completions');
    const main = findProvider(loadRegistry(path, env), 'main');
    assert.equal(main.models.find((row) => row.id === 'glm')?.api, 'anthropic-messages');
    assert.equal(main.models.find((row) => row.id === 'new-model')?.api, 'chat-completions');
    assert.match(readFileSync(path, 'utf8'), /\$MAIN_KEY/, '$VAR 原样保留');
  });
});
