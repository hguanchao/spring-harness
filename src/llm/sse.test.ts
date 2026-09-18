import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { postSseStream } from './sse.js';
import { RetryableError } from './retry.js';

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

async function collectSse(body: string): Promise<string[]> {
  const original = globalThis.fetch;
  const payloads: string[] = [];
  globalThis.fetch = (async () =>
    new Response(body, { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;
  try {
    await postSseStream({
      url: 'http://example.invalid/v1/responses',
      headers: {},
      body: '{}',
      onData: (payload) => payloads.push(payload),
    });
    return payloads;
  } finally {
    globalThis.fetch = original;
  }
}

describe('postSseStream without [DONE]', () => {
  it('有 data 但流干净结束且没有 [DONE] 视为完成', async () => {
    const payloads = await collectSse(`data: ${JSON.stringify({ type: 'response.completed' })}\n\n`);
    assert.deepEqual(payloads, [JSON.stringify({ type: 'response.completed' })]);
  });

  it('event: 补 type，末帧无空行也 dispatch', async () => {
    const payloads = await collectSse(
      'event: response.output_text.delta\ndata: {"delta":"hi"}\n\nevent: response.completed\ndata: {}',
    );
    assert.equal(JSON.parse(payloads[0] ?? '').type, 'response.output_text.delta');
    assert.equal(JSON.parse(payloads[0] ?? '').delta, 'hi');
    assert.equal(JSON.parse(payloads[1] ?? '').type, 'response.completed');
  });

  it('event: response.completed 无 data 也算完成', async () => {
    const payloads = await collectSse(
      'event: response.output_text.delta\ndata: {"delta":"x"}\n\nevent: response.completed\n\n',
    );
    assert.equal(JSON.parse(payloads[1] ?? '').type, 'response.completed');
  });

  it('NDJSON 无 data: 前缀也能收下', async () => {
    const payloads = await collectSse(
      `${JSON.stringify({ choices: [{ delta: { content: 'a' } }] })}\n${JSON.stringify({ choices: [{ delta: { content: 'b' }, finish_reason: 'stop' }] })}\n`,
    );
    assert.equal(payloads.length, 2);
    assert.equal(JSON.parse(payloads[1] ?? '').choices[0].finish_reason, 'stop');
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

describe('postSseStream x-should-retry', () => {
  it('网关说 x-should-retry: false 时 5xx 也不重试', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: 'backend exploded' } }), {
        status: 502,
        headers: { 'content-type': 'application/json', 'x-should-retry': 'false' },
      })) as typeof fetch;
    try {
      await assert.rejects(
        () =>
          postSseStream({
            url: 'http://example.invalid/v1/chat',
            headers: {},
            body: '{}',
            onData: () => {},
          }),
        (error: unknown) => !(error instanceof RetryableError) && /502/.test(String(error)),
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it('没有该头时 5xx 照常可重试', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: 'backend exploded' } }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    try {
      await assert.rejects(
        () =>
          postSseStream({
            url: 'http://example.invalid/v1/chat',
            headers: {},
            body: '{}',
            onData: () => {},
          }),
        (error: unknown) => error instanceof RetryableError,
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});
