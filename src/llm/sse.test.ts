import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { postSseStream } from './sse.js';
import { RetryableError, StreamClosedError } from './retry.js';

describe('postSseStream network error', () => {
  it('fetch failed 带上 cause.code，方便对照代理/TLS', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      const err = new TypeError('fetch failed');
      err.cause = Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'), {
        code: 'ECONNRESET',
      });
      throw err;
    }) as typeof fetch;
    try {
      await assert.rejects(
        () =>
          postSseStream({
            url: 'http://example.invalid/v1/chat',
            headers: {},
            body: '{}',
            onData: () => {},
          }),
        (error: unknown) =>
          error instanceof RetryableError
          && error.message.includes('fetch failed')
          && error.message.includes('ECONNRESET'),
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('postSseStream empty body', () => {
  it('空 SSE 体抛 RetryableError，而不是普通 Error', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('', { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;
    try {
      await assert.rejects(
        () =>
          postSseStream({
            url: 'http://example.invalid/v1/chat',
            headers: {},
            body: '{}',
            onData: () => {},
          }),
        (error: unknown) =>
          error instanceof RetryableError && /no SSE data events/.test(error.message) && /empty body/.test(error.message),
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it('application/json 整段当作一条 payload', async () => {
    const original = globalThis.fetch;
    const payloads: string[] = [];
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    try {
      await postSseStream({
        url: 'http://example.invalid/v1/chat',
        headers: {},
        body: '{}',
        onData: (payload) => payloads.push(payload),
      });
      assert.deepEqual(payloads, [JSON.stringify({ ok: true })]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('postSseStream first-byte timeout', () => {
  it('hangs with no bytes use first-byte timeout, not the long idle window', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start() {
            /* never enqueue */
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )) as typeof fetch;
    const started = Date.now();
    try {
      await assert.rejects(
        () =>
          postSseStream({
            url: 'http://example.invalid/v1/chat',
            headers: {},
            body: '{}',
            onData: () => {},
            idleTimeoutMs: 5_000,
            firstByteTimeoutMs: 40,
          }),
        (error: unknown) => error instanceof RetryableError && error.message.includes('idle timeout'),
      );
      assert.ok(Date.now() - started < 1000, 'should not wait for the 5s idle window');
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('postSseStream without [DONE]', () => {
  it('有 data 但流干净结束且没有 [DONE] 抛 StreamClosedError', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      )) as typeof fetch;
    try {
      await assert.rejects(
        () =>
          postSseStream({
            url: 'http://example.invalid/v1/chat',
            headers: {},
            body: '{}',
            onData: () => {},
          }),
        (error: unknown) => error instanceof StreamClosedError,
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('postSseStream idle timeout', () => {
  it('times out when the body never yields a chunk', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start() {
            /* never enqueue — hang until idle timeout */
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )) as typeof fetch;
    try {
      await assert.rejects(
        () =>
          postSseStream({
            url: 'http://example.invalid/v1/chat',
            headers: {},
            body: '{}',
            onData: () => {},
            idleTimeoutMs: 30,
          }),
        (error: unknown) => error instanceof RetryableError && error.message.includes('idle timeout'),
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});
