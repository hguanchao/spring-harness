import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyHttpError,
  ContextOverflowError,
  looksLikeContextOverflow,
  looksLikeQuotaExceeded,
  streamFrameError,
} from '../../src/plugins/sph-llm/errors.js';
import { RetryableError } from '../../src/plugins/sph-llm/retry.js';

describe('looksLikeContextOverflow', () => {
  it('认结构化 context_window_limit_exceeded', () => {
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

describe('streamFrameError', () => {
  it('网关断流/过载措辞按传输抖动可重试', () => {
    assert.ok(streamFrameError('LLM error', 'Upstream stream disconnected') instanceof RetryableError);
    assert.ok(streamFrameError('Anthropic stream error', 'Overloaded_error') instanceof RetryableError);
    assert.ok(streamFrameError('Responses stream error', 'upstream connect error') instanceof RetryableError);
  });

  it('终态措辞（审核/鉴权/参数/额度）原样上抛不可重试', () => {
    for (const message of [
      'content_filter: your prompt was flagged',
      '内容审核未通过',
      'invalid api key',
      'invalid_request_error: unsupported parameter',
      'insufficient quota',
    ]) {
      const error = streamFrameError('LLM error', message);
      assert.ok(!(error instanceof RetryableError), message);
    }
  });

  it('超窗仍产出 ContextOverflowError 走压缩重试', () => {
    assert.ok(
      streamFrameError('LLM error', "This model's maximum context length is exceeded") instanceof ContextOverflowError,
    );
  });
});
