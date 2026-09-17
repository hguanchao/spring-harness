import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applySsePayload, finishStream, newSseAcc } from './openai.js';

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

