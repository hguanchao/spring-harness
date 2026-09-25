import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildRequestBody } from '../../src/plugins/sph-llm/openai.js';

describe('buildRequestBody 文档降级', () => {
  it('chat.completions 没有文档形态：document part 降级成正文说明，其余 parts 原样保留', () => {
    const body = buildRequestBody({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: '总结这份 PDF',
          parts: [
            { type: 'image_url', image_url: { url: 'data:image/png;base64,xx' } },
            { type: 'document', document: { filename: 'spec.pdf', url: 'data:application/pdf;base64,JVBERi0=' } },
          ],
        },
      ],
      tools: [],
    });
    const content = (body.messages as Array<Record<string, unknown>>)[0]!.content as Array<Record<string, unknown>>;
    assert.equal(content.some((part) => part.type === 'document'), false, 'chat.completions 不应出现 document 类型');
    assert.equal(content.some((part) => part.type === 'image_url'), true, '图片不受文档降级牵连');
    const text = String(content[0]?.text);
    assert.match(text, /spec\.pdf/);
    assert.match(text, /总结这份 PDF/, '原文仍在正文里');
  });
});

import { costUsd } from '../../src/llm/client.js';

describe('buildRequestBody 图片降级', () => {
  it('supportsImages=false：image_url 部件降级成说明文本', () => {
    const body = buildRequestBody({
      model: 'gpt-5.2',
      messages: [{
        role: 'user',
        content: '看这张图',
        parts: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,xx' } }],
      }],
      tools: [],
      supportsImages: false,
    });
    const content = (body.messages as Array<Record<string, unknown>>)[0]!.content as Array<Record<string, unknown>>;
    assert.equal(content.some((part) => part.type === 'image_url'), false);
    assert.match(String(content[0]?.text), /does not accept image input/);
  });
});

describe('costUsd 计价', () => {
  const rates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 };

  it('未缓存输入 + 缓存命中 + 输出各按自己的单价折算', () => {
    const usd = costUsd(
      { promptTokens: 1_000_000, completionTokens: 200_000, totalTokens: 1_200_000, cachedTokens: 500_000 },
      rates,
    );
    // (0.5M×$3 + 0.5M×$0.3 + 0.2M×$15) / 1M
    assert.equal(usd, 4.65);
  });

  it('没上报缓存用量时全部输入按 input 价', () => {
    const usd = costUsd({ promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 }, rates);
    assert.equal(usd, 3);
  });
});
