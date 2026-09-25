import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  degradeRequestCaps,
  initialRequestCaps,
  type RequestCaps,
} from '../../src/plugins/sph-llm/compat.js';

/** 降级用例需要 key/retention 都开着，才能断言报文剥的是哪一位。 */
function cacheOn(caps = initialRequestCaps('gpt-4o', true)): RequestCaps {
  return { ...caps, promptCacheKey: true, promptCacheRetention: true };
}

/** 从默认能力位出发做一次降级，避免每条用例都手写整份对象。 */
function after(text: string, caps = initialRequestCaps('gpt-4o', true)) {
  return degradeRequestCaps(caps, text);
}

describe('initialRequestCaps 按协议默认字段', () => {
  it('不看主机名，chat 先发 max_tokens', () => {
    for (const baseUrl of [undefined, 'https://api.openai.com/v1', 'https://api.deepseek.com/v1']) {
      assert.equal(initialRequestCaps('gpt-5', true, { baseUrl }).outputLimit, 'max_tokens', baseUrl);
    }
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

describe('缓存字段不看主机', () => {
  it('打开 prompt cache 就发 key，retention 仍要 compat 打开', () => {
    const caps = initialRequestCaps('gpt-4o', true, { baseUrl: 'https://proxy.example.com/v1' });
    assert.equal(caps.promptCache, true);
    assert.equal(caps.promptCacheKey, true);
    assert.equal(caps.promptCacheRetention, false);
    assert.equal(caps.streamOptions, true);
    assert.equal(initialRequestCaps('gpt-4o', true, { baseUrl: 'https://api.openai.com/v1' }).promptCacheKey, true);
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
    assert.equal(next?.outputLimit, 'max_completion_tokens');
  });

  it('报文点名 max_output_tokens 时换过去', () => {
    const caps = { ...initialRequestCaps('m', true), outputLimit: 'max_completion_tokens' as const };
    assert.equal(caps.outputLimit, 'max_completion_tokens');
    const next = degradeRequestCaps(
      caps,
      "Unsupported parameter: 'max_tokens' is not supported by this endpoint. Use max_output_tokens.",
    );
    assert.equal(next?.outputLimit, 'max_output_tokens');
  });

  it('两个名字同时出现时按「迁向新名字」处理', () => {
    // OpenAI 的真实报文就是这种形态；即便端点意图相反，下一轮会被反向规则翻回来。
    const caps = { ...initialRequestCaps('gpt-4o', true) };
    assert.equal(caps.outputLimit, 'max_tokens');
    const next = degradeRequestCaps(
      caps,
      "Unsupported parameter: 'max_tokens' is not supported. Use 'max_completion_tokens' instead.",
    );
    assert.equal(next?.outputLimit, 'max_completion_tokens');
  });

  it('不认识 reasoning_effort 时不再发送', () => {
    const next = after("Unsupported parameter: 'reasoning_effort' is not supported with this model.");
    assert.equal(next?.reasoningWire, 'off');
  });

  it('报文点名 enable_thinking 时改用通义兼容模式的布尔', () => {
    const next = after("unknown parameter reasoning_effort. use enable_thinking instead");
    assert.equal(next?.reasoningWire, 'enable_thinking');
  });

  it('Anthropic 要求 adaptive 时从预算思考换过去', () => {
    const next = after("budget_tokens is not supported for this model. Use thinking.type adaptive instead.");
    assert.equal(next?.adaptiveThinking, true);
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


describe('文档块的降级', () => {
  const after = (text: string): RequestCaps | undefined => degradeRequestCaps(initialRequestCaps('gpt-4o', true), text);

  it('input_file 不被认时降 sendDocuments', () => {
    const next = after("Unknown parameter: 'input_file'.");
    assert.equal(next?.sendDocuments, false);
  });

  it('file_data 被拒同样降级', () => {
    const next = after('Invalid value: file_data must be a data URL.');
    assert.equal(next?.sendDocuments, false);
  });

  it('带引号的 document 类型字面量被拒时降级', () => {
    const next = after("messages.0.content.1.type: Input tag 'document' is unsupported.");
    assert.equal(next?.sendDocuments, false);
  });

  it('无关报文里出现 document 一词不误伤', () => {
    assert.equal(after('the document you sent is too large'), undefined);
  });
});
