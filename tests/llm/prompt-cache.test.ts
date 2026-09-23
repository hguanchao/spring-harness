import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clampPromptCacheKey, openaiSessionHeaders, PROMPT_CACHE_KEY_MAX_LENGTH } from '../../src/plugins/sph-llm/prompt-cache.js';

describe('clampPromptCacheKey', () => {
  it('不超过上限时原样返回', () => {
    assert.equal(clampPromptCacheKey('session-1'), 'session-1');
  });

  it('undefined 原样通过（调用方据此不发送该字段）', () => {
    assert.equal(clampPromptCacheKey(undefined), undefined);
  });

  it('超长时截到 64 个字符', () => {
    const long = 'a'.repeat(PROMPT_CACHE_KEY_MAX_LENGTH + 10);
    const clamped = clampPromptCacheKey(long);
    assert.equal(clamped?.length, PROMPT_CACHE_KEY_MAX_LENGTH);
  });

  it('按码点截断：emoji 的代理对不从中间劈开', () => {
    // 40 个 emoji（每个 2 个 UTF-16 码元）+ 60 个 ASCII = 100 码点、140 码元。
    // 若按码元 slice，64 码元会落在第 32 个 emoji 的中间，产生一个非法的孤立低位。
    const mixed = '🎉'.repeat(40) + 'a'.repeat(60);
    const clamped = clampPromptCacheKey(mixed)!;
    assert.equal(Array.from(clamped).length, PROMPT_CACHE_KEY_MAX_LENGTH);
    assert.match(clamped, /^(?:🎉)+a*$/u, '截断处只能是完整的 emoji 或 ASCII 字符');
  });
});

describe('openaiSessionHeaders', () => {
  it('openai 形态带上三个常见亲和头', () => {
    const headers = openaiSessionHeaders('s-123', 'openai');
    assert.equal(headers.session_id, 's-123');
    assert.equal(headers['x-client-request-id'], 's-123');
    assert.equal(headers['x-session-affinity'], 's-123');
  });

  it('openrouter 只认 x-session-id，多发无益', () => {
    const headers = openaiSessionHeaders('s-123', 'openrouter');
    assert.equal(headers['x-session-id'], 's-123');
    assert.equal(headers.session_id, undefined);
    assert.equal(headers['x-session-affinity'], undefined);
  });

  it('off 不发任何亲和头', () => {
    assert.deepEqual(openaiSessionHeaders('s-123', 'off'), {});
  });
});
