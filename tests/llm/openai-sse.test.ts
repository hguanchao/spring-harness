import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applySsePayload, finishStream, newSseAcc } from '../../src/plugins/sph-llm/openai.js';

describe('chat.completions 思考字段', () => {
  it('认 delta.reasoning，避免中转站不写 reasoning_content 时一直 Calling model…', () => {
    const acc = newSseAcc();
    const delta = applySsePayload(
      JSON.stringify({
        choices: [{ delta: { reasoning: 'We need to reply', role: 'assistant' }, index: 0 }],
      }),
      acc,
    );
    assert.equal(delta.thinkingDelta, 'We need to reply');
    assert.equal(finishStream(acc).thinking, 'We need to reply');
  });

  it('同时存在时优先 reasoning_content', () => {
    const acc = newSseAcc();
    applySsePayload(
      JSON.stringify({
        choices: [{ delta: { reasoning_content: 'official', reasoning: 'alias' } }],
      }),
      acc,
    );
    assert.equal(finishStream(acc).thinking, 'official');
  });

  it('认 delta.thinking 与 delta.text', () => {
    const acc = newSseAcc();
    applySsePayload(JSON.stringify({ choices: [{ delta: { thinking: 'hmm' } }] }), acc);
    applySsePayload(JSON.stringify({ choices: [{ delta: { text: 'pong' } }] }), acc);
    const reply = finishStream(acc);
    assert.equal(reply.thinking, 'hmm');
    assert.equal(reply.text, 'pong');
  });

  it('用量认 input_tokens / output_tokens', () => {
    const acc = newSseAcc();
    applySsePayload(
      JSON.stringify({
        choices: [{ delta: { content: 'x' } }],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      }),
      acc,
    );
    assert.deepEqual(finishStream(acc).usage, {
      promptTokens: 10,
      completionTokens: 2,
      totalTokens: 12,
    });
  });
});


describe('chat.completions 网关变体', () => {
  it('Moonshot 把 usage 放 choice.usage：顶层缺失时回退读取', () => {
    const acc = newSseAcc();
    applySsePayload(
      JSON.stringify({
        choices: [
          {
            usage: { prompt_tokens: 100, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 60 } },
            delta: {},
            finish_reason: 'stop',
          },
        ],
      }),
      acc,
    );
    assert.deepEqual(finishStream(acc).usage, {
      promptTokens: 100,
      completionTokens: 30,
      totalTokens: 130,
      cachedTokens: 60,
    });
  });

  it('不发 index 的网关按 id 寻址，两个并行工具不并成一条', () => {
    const acc = newSseAcc();
    applySsePayload(
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ id: 'call_a', function: { name: 'alpha', arguments: '{"x":' } }] } }],
      }),
      acc,
    );
    // 第二个调用首包：id 不同 → 新槽位
    applySsePayload(
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ id: 'call_b', function: { name: 'beta', arguments: '' } }] } }],
      }),
      acc,
    );
    // 两个调用各自的续传包：无 index 无 id → 挂在最近一条上，靠「id 不同即换槽」的
    // 时序假设。这里先回 call_b 的参数，再回 call_a 的（带 id，按 id 找回原槽）。
    applySsePayload(
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { arguments: '1}' } }] } }] }),
      acc,
    );
    applySsePayload(
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ id: 'call_a', function: { arguments: '2}' } }] } }],
      }),
      acc,
    );
    const tools = finishStream(acc).toolCalls ?? [];
    assert.equal(tools.length, 2);
    const byId = new Map(tools.map((t) => [t.id, t]));
    assert.equal(byId.get('call_a')?.name, 'alpha');
    assert.equal(byId.get('call_a')?.arguments, '{"x":2}');
    assert.equal(byId.get('call_b')?.name, 'beta');
    assert.equal(byId.get('call_b')?.arguments, '1}');
  });
});
