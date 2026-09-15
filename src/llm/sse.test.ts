import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { postSseStream } from './sse.js';
import { RetryableError } from './retry.js';

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
