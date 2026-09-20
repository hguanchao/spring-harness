import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  degradeRequestCaps,
  degradeSilentCompat,
  detectSessionAffinity,
  initialRequestCaps,
  isOfficialOpenAI,
  type RequestCaps,
} from '../../src/llm/compat.js';

/** 降级用例需要 key/retention 都开着，才能断言报文剥的是哪一位。 */
function cacheOn(caps = initialRequestCaps('gpt-4o', true)): RequestCaps {
  return { ...caps, promptCacheKey: true, promptCacheRetention: true };
}

/** 从默认能力位出发做一次降级，避免每条用例都手写整份对象。 */
function after(text: string, caps = initialRequestCaps('gpt-4o', true)) {
  return degradeRequestCaps(caps, text);
}

describe('initialRequestCaps 模型名启发式', () => {
  it('o 系列与 gpt-5 首个请求就用 max_completion_tokens', () => {
    for (const model of ['o1', 'o1-mini', 'o3-mini', 'o4-mini', 'gpt-5', 'gpt-5-mini']) {
      assert.equal(initialRequestCaps(model, true).maxCompletionTokens, true, model);
    }
  });

  it('网关的厂商前缀不影响识别', () => {
    // OpenRouter 一类网关返回 openai/o3-mini，裸名匹配才拿得准。
    assert.equal(initialRequestCaps('openai/o3-mini', true).maxCompletionTokens, true);
  });

  it('名字只是以 o+数字开头的不误伤', () => {
    assert.equal(initialRequestCaps('o3xxx', true).maxCompletionTokens, false);
    assert.equal(initialRequestCaps('gpt-4o', true).maxCompletionTokens, false);
    assert.equal(initialRequestCaps('claude-sonnet-4', true).maxCompletionTokens, false);
  });

  it('promptCache 原样透传，其余位取默认', () => {
    const caps = initialRequestCaps('gpt-4o', false);
    assert.equal(caps.promptCache, false);
    assert.equal(caps.streamOptions, true);
    assert.equal(caps.sendStore, true);
    assert.equal(caps.sendReasoning, true);
    assert.equal(caps.promptCacheKey, false);
    assert.equal(caps.promptCacheRetention, false);
  });
});

describe('未知端点默认少发缓存字段', () => {
  it('只认官方 api.openai.com', () => {
    assert.equal(isOfficialOpenAI('https://api.openai.com/v1'), true);
    assert.equal(isOfficialOpenAI('https://api.openai.com'), true);
    assert.equal(isOfficialOpenAI('https://proxy.example.com/v1'), false);
    assert.equal(isOfficialOpenAI('https://openrouter.ai/api/v1'), false);
    assert.equal(isOfficialOpenAI('http://example.invalid/v1'), false);
  });

  it('OpenRouter 只改亲和头格式，不当成官方 OpenAI', () => {
    assert.equal(detectSessionAffinity('https://openrouter.ai/api/v1'), 'openrouter');
    assert.equal(detectSessionAffinity('https://api.openai.com/v1'), 'openai');
    assert.equal(detectSessionAffinity('https://proxy.example.com/v1'), 'openai');
  });

  it('未知 URL 不发 key 与 retention', () => {
    const caps = initialRequestCaps('gpt-4o', true, { baseUrl: 'https://proxy.example.com/v1' });
    assert.equal(caps.promptCache, true);
    assert.equal(caps.promptCacheKey, false);
    assert.equal(caps.promptCacheRetention, false);
    assert.equal(caps.streamOptions, true);
  });

  it('官方 OpenAI 发 key，不发 retention', () => {
    const caps = initialRequestCaps('gpt-4o', true, { baseUrl: 'https://api.openai.com/v1' });
    assert.equal(caps.promptCacheKey, true);
    assert.equal(caps.promptCacheRetention, false);
  });

  it('[compat] 覆盖推断', () => {
    const caps = initialRequestCaps('gpt-4o', true, {
      baseUrl: 'https://proxy.example.com/v1',
      compat: { promptCacheKey: true, promptCacheRetention: true, streamOptions: false },
    });
    assert.equal(caps.promptCacheKey, true);
    assert.equal(caps.promptCacheRetention, true);
    assert.equal(caps.streamOptions, false);
  });

  it('prompt_cache=false 否决官方 OpenAI 与 [compat] 的 cache 字段', () => {
    const caps = initialRequestCaps('gpt-4o', false, {
      baseUrl: 'https://api.openai.com/v1',
      compat: { promptCacheKey: true, promptCacheRetention: true },
    });
    assert.equal(caps.promptCache, false);
    assert.equal(caps.promptCacheKey, false);
    assert.equal(caps.promptCacheRetention, false);
  });
});

describe('degradeRequestCaps', () => {
  it('OpenAI 的真实报文：迁到 max_completion_tokens', () => {
    const next = after(
      "LLM HTTP 400: Unsupported parameter: 'max_tokens' is not supported with this model."
      + " Use 'max_completion_tokens' instead.",
    );
    assert.equal(next?.maxCompletionTokens, true);
  });

  it('反向报文：端点只认 max_tokens 时翻回来', () => {
    const caps = { ...initialRequestCaps('o3-mini', true) };
    assert.equal(caps.maxCompletionTokens, true);
    const next = degradeRequestCaps(
      caps,
      "Unsupported parameter: 'max_tokens' is not supported by this endpoint",
    );
    assert.equal(next?.maxCompletionTokens, false);
  });

  it('两个名字同时出现时按「迁向新名字」处理', () => {
    // OpenAI 的真实报文就是这种形态；即便端点意图相反，下一轮会被反向规则翻回来。
    const caps = { ...initialRequestCaps('gpt-4o', true) };
    assert.equal(caps.maxCompletionTokens, false);
    const next = degradeRequestCaps(
      caps,
      "Unsupported parameter: 'max_tokens' is not supported. Use 'max_completion_tokens' instead.",
    );
    assert.equal(next?.maxCompletionTokens, true);
  });

  it('不认识 stream_options 时关掉它', () => {
    const next = after('Unrecognized request argument supplied: stream_options');
    assert.equal(next?.streamOptions, false);
  });

  it("不认识 'store' 时整条摘掉", () => {
    const next = after("Unsupported parameter: 'store' is not supported by this endpoint");
    assert.equal(next?.sendStore, false);
  });

  it('store 的词边界判断不会命中 restore', () => {
    // "restore" 里的 store 左边不是词边界，不该被当成参数名。
    assert.equal(after('Unsupported parameter: could not restore checkpoint'), undefined);
  });

  it('zen Console 的措辞不带 unsupported，也要能识别', () => {
    const next = after('LLM HTTP 400: encrypted_content was not issued to this caller');
    assert.equal(next?.sendReasoning, false);
  });

  it('cache_control 被拒时关掉 prompt cache', () => {
    const next = after('messages.0.content.0.cache_control: Extra inputs are not permitted');
    assert.equal(next?.promptCache, false);
  });

  it('已经是目标状态时不再重复降级', () => {
    const caps = { ...initialRequestCaps('gpt-4o', true), streamOptions: false };
    assert.equal(degradeRequestCaps(caps, 'Unrecognized request argument supplied: stream_options'), undefined);
  });

  it('上下文超窗不能被当成参数问题吞掉', () => {
    // 这类错误必须原样上抛，让 loop 认出 ContextOverflowError 去压缩重试。
    assert.equal(after("LLM HTTP 400: This model's maximum context length is 128000 tokens"), undefined);
    assert.equal(after('LLM HTTP 400: prompt is too long: 200000 tokens > 128000 maximum'), undefined);
  });

  it('普通 400 / 鉴权错误不触发降级', () => {
    assert.equal(after('LLM HTTP 400: invalid model: nope'), undefined);
    assert.equal(after('LLM HTTP 401: invalid api key'), undefined);
  });
});

describe('缓存路由参数的降级', () => {
  const after = (text: string): RequestCaps | undefined => degradeRequestCaps(cacheOn(), text);

  it('prompt_cache_retention 被拒时先降 retention，key 保留', () => {
    const next = after("Unsupported parameter: 'prompt_cache_retention' is not supported with this model.");
    assert.equal(next?.promptCacheRetention, false);
    assert.equal(next?.promptCacheKey, true);
  });

  it('prompt_cache_key 被拒时降 key', () => {
    const next = after("Unrecognized request argument supplied: prompt_cache_key");
    assert.equal(next?.promptCacheKey, false);
    assert.equal(next?.promptCacheRetention, true);
  });

  it('prompt_cache=false 时初始能力位连 key 与 retention 一起关', () => {
    const caps = initialRequestCaps('gpt-4o', false);
    assert.equal(caps.promptCache, false);
    assert.equal(caps.promptCacheKey, false);
    assert.equal(caps.promptCacheRetention, false);
  });
});

describe('degradeSilentCompat', () => {
  it('按 stream_options → retention → key 的顺序剥，没有 unsupported 字样也能降', () => {
    let caps = cacheOn();
    caps = degradeSilentCompat(caps)!;
    assert.equal(caps.streamOptions, false);
    assert.equal(caps.promptCacheRetention, true);
    caps = degradeSilentCompat(caps)!;
    assert.equal(caps.promptCacheRetention, false);
    assert.equal(caps.promptCacheKey, true);
    caps = degradeSilentCompat(caps)!;
    assert.equal(caps.promptCacheKey, false);
    assert.equal(degradeSilentCompat(caps), undefined);
  });
});
