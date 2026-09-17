import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyHttpError, looksLikeContextOverflow, looksLikeQuotaExceeded } from './errors.js';

describe('looksLikeContextOverflow', () => {
  it('认 dsh 结构化 context_window_limit_exceeded', () => {
    assert.equal(looksLikeContextOverflow('context_window_limit_exceeded'), true);
  });

  it('认 too large for model context', () => {
    assert.equal(looksLikeContextOverflow('prompt is too large for the model context window'), true);
  });
});

describe('classifyHttpError', () => {
  it('401/403 是 AUTH，额度用尽不是 RATE_LIMIT', () => {
    assert.equal(classifyHttpError(401, 'nope'), 'AUTH');
    assert.equal(classifyHttpError(429, 'insufficient quota'), 'QUOTA');
    assert.equal(looksLikeQuotaExceeded('out of credits'), true);
    assert.equal(classifyHttpError(429, 'slow down'), 'RATE_LIMIT');
    assert.equal(classifyHttpError(500, 'boom'), 'SERVER');
    assert.equal(classifyHttpError(400, 'context length exceeded'), 'CONTEXT_WINDOW_EXCEEDED');
    assert.equal(classifyHttpError(400, 'bad field'), 'INVALID_REQUEST');
  });
});
