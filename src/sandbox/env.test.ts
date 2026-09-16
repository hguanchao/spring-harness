import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeChildEnv, scrubbedParentEnv, windowsEnvBlock } from './env.js';

describe('scrubbedParentEnv', () => {
  it('丢掉 KEY/TOKEN/SECRET/PASSWORD 与 SPH_ 前缀，保留 PATH', () => {
    const env = scrubbedParentEnv({
      PATH: '/usr/bin',
      SPH_API_KEY: 'secret',
      NPM_TOKEN: 'npm',
      MY_SECRET: 'x',
      DB_PASSWORD: 'p',
      HOME: '/home/u',
    });
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.HOME, '/home/u');
    assert.equal(env.SPH_API_KEY, undefined);
    assert.equal(env.NPM_TOKEN, undefined);
    assert.equal(env.MY_SECRET, undefined);
    assert.equal(env.DB_PASSWORD, undefined);
  });

  it('显式 extra 可覆盖擦除，把 MCP 自己的密钥交出去', () => {
    const env = mergeChildEnv(
      { MCP_TOKEN: 'from-spec' },
      { PATH: '/bin', SPH_API_KEY: 'host', MCP_TOKEN: 'ambient' },
    );
    assert.equal(env.PATH, '/bin');
    assert.equal(env.SPH_API_KEY, undefined);
    assert.equal(env.MCP_TOKEN, 'from-spec');
  });

  it('Windows 环境块以双 NUL 结尾', () => {
    const block = windowsEnvBlock({ PATH: 'C:\\Windows' });
    assert.ok(block.includes(Buffer.from('PATH=C:\\Windows\0\0', 'utf16le')));
  });
});
