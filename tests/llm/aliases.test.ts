import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  COMPLETION_TOKEN_KEYS,
  firstFiniteNumber,
  firstString,
  PROMPT_TOKEN_KEYS,
  TEXT_KEYS,
  THINKING_KEYS,
} from '../../src/llm/aliases.js';

describe('响应字段并集', () => {
  it('思考键按 reasoning_content → reasoning → thinking', () => {
    assert.equal(firstString({ reasoning: 'alias', thinking: 'third' }, THINKING_KEYS), 'alias');
    assert.equal(firstString({ reasoning_content: 'official', reasoning: 'alias' }, THINKING_KEYS), 'official');
    assert.equal(firstString({ thinking: 'anthropic-like' }, THINKING_KEYS), 'anthropic-like');
    assert.equal(firstString({ reasoning: '' }, THINKING_KEYS), undefined);
  });

  it('正文键按 content → text', () => {
    assert.equal(firstString({ text: 'alt', content: 'main' }, TEXT_KEYS), 'main');
    assert.equal(firstString({ text: 'only' }, TEXT_KEYS), 'only');
  });

  it('用量认 prompt_tokens / input_tokens', () => {
    assert.equal(firstFiniteNumber({ input_tokens: 12, prompt_tokens: 9 }, PROMPT_TOKEN_KEYS), 9);
    assert.equal(firstFiniteNumber({ input_tokens: 12 }, PROMPT_TOKEN_KEYS), 12);
    assert.equal(firstFiniteNumber({ output_tokens: 3 }, COMPLETION_TOKEN_KEYS), 3);
  });
});
