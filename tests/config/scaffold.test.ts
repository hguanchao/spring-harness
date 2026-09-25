import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { ConfigError, loadConfig } from '../../src/config/load.js';
import { parseRegistry } from '../../src/config/registry.js';
import { REFERENCE_CONFIG_TOML, REFERENCE_MODELS_JSON, scaffoldUserHome } from '../../src/config/scaffold.js';

describe('scaffoldUserHome 首次运行脚手架', () => {
  const dirs: string[] = [];
  const makeHome = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'sph-scaffold-'));
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('全新目录：两份模板都生成，且模板能被 parseRegistry 原样解析', () => {
    const home = makeHome();
    const created = scaffoldUserHome({ homeDir: home });
    assert.equal(created.length, 2);
    const registry = parseRegistry(JSON.parse(readFileSync(join(home, 'models.json'), 'utf8')), {});
    assert.deepEqual(registry.providers.map((provider) => provider.name), ['example-openai']);
    assert.equal(registry.providers[0]!.api, 'chat-completions');
    // 模型级 api 覆盖：缺席继承 provider,写了的按模型走——三种协议各演示一个。
    const models = registry.providers[0]!.models;
    assert.deepEqual(models.map((model) => model.api), [undefined, 'responses', 'anthropic-messages']);
  });

  it('config.toml 模板指向示例 provider：未填 key 时启动报错点名它，而不是 401', () => {
    const home = makeHome();
    scaffoldUserHome({ homeDir: home });
    assert.throws(
      () => loadConfig({
        configPath: join(home, 'config.toml'),
        registryPath: join(home, 'models.json'),
        env: {},
      }),
      (error: unknown) => error instanceof ConfigError
        && /example-openai/.test(error.message)
        && /no apiKey/.test(error.message),
    );
  });

  it('已有文件绝不覆盖：用户手写的 models.json 原样保留', () => {
    const home = makeHome();
    const custom = '{"providers":{"mine":{"baseUrl":"https://x/v1","apiKey":"k","models":[{"id":"m"}]}}}';
    writeFileSync(join(home, 'models.json'), custom, 'utf8');
    const created = scaffoldUserHome({ homeDir: home });
    assert.deepEqual(created, [join(home, 'config.toml')], '只补缺失的那份');
    assert.equal(readFileSync(join(home, 'models.json'), 'utf8'), custom);
  });

  it('两份都在时什么都不写、不报错', () => {
    const home = makeHome();
    writeFileSync(join(home, 'models.json'), REFERENCE_MODELS_JSON, 'utf8');
    writeFileSync(join(home, 'config.toml'), REFERENCE_CONFIG_TOML, 'utf8');
    assert.deepEqual(scaffoldUserHome({ homeDir: home }), []);
    assert.ok(existsSync(join(home, 'models.json')));
    assert.ok(existsSync(join(home, 'config.toml')));
  });
});
