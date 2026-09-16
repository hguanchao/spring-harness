import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { createSseClient } from './stream-client.js';
import { openaiAdapter, type ChatMessage } from './openai.js';
import { ContextOverflowError } from './errors.js';
import { RetryableError } from './retry.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];

function sseResponse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

/** 先吐一段正文再断流：用来验证「已经输出过内容就不再重发」。 */
function streamThenFail(text: string): Response {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled++ === 0) {
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`),
        );
        return;
      }
      controller.error(new RetryableError('socket died'));
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function okResponse(text: string): Response {
  const payload = JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] });
  return sseResponse([`data: ${payload}\n\n`, 'data: [DONE]\n\n']);
}

/** 记录每次请求体，并让第一个响应失败、之后成功。 */
function stubFetch(record: Array<Record<string, unknown>>, first: () => Response, success = 'ok'): void {
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    record.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return record.length === 1 ? first() : okResponse(success);
  }) as typeof fetch;
}

function client(model = 'gpt-4o') {
  return createSseClient(openaiAdapter, {
    baseUrl: 'http://example.invalid/v1',
    apiKey: 'k',
    model,
    maxTokens: 100,
  });
}

describe('参数降级重试', () => {
  it("端点拒收 max_tokens 时改名重发，并把结果记在 client 上", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    stubFetch(bodies, () =>
      errorResponse(
        400,
        "Unsupported parameter: 'max_tokens' is not supported with this model."
        + " Use 'max_completion_tokens' instead.",
      ),
    );

    const c = client();
    const reply = await c.complete(messages, []);
    assert.equal(reply.text, 'ok');
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0]?.max_tokens, 100);
    assert.equal(bodies[0]?.max_completion_tokens, undefined);
    assert.equal(bodies[1]?.max_completion_tokens, 100);
    assert.equal(bodies[1]?.max_tokens, undefined);

    // 第二次调用不该再吃一次同样的 400：能力位记在闭包里。
    await c.complete(messages, []);
    assert.equal(bodies.length, 3);
    assert.equal(bodies[2]?.max_completion_tokens, 100);
    assert.equal(bodies[2]?.max_tokens, undefined);
  });

  it('o 系列首个请求就用 max_completion_tokens，不必先失败一次', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    stubFetch(bodies, () => okResponse('unused'));

    await client('openai/o3-mini').complete(messages, []);
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0]?.max_completion_tokens, 100);
    assert.equal(bodies[0]?.max_tokens, undefined);
  });

  it('端点不认识 stream_options 时摘掉它重发', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    stubFetch(bodies, () => errorResponse(400, 'Unrecognized request argument supplied: stream_options'));

    await client().complete(messages, []);
    assert.deepEqual(bodies[0]?.stream_options, { include_usage: true });
    assert.equal(bodies[1]?.stream_options, undefined);
  });

  it('端点持续拒收同一参数时在上限内停止，不无限重发', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return errorResponse(400, "Unsupported parameter: 'stream_options' is not supported");
    }) as typeof fetch;

    await assert.rejects(() => client().complete(messages, []), /LLM HTTP 400/);
    // 第一次 400 关掉 stream_options；第二次 400 已无可降级 → 立即上抛。
    assert.equal(calls, 2);
  });
});

describe('不重发的边界', () => {
  it('已经输出过正文后即使可重试类错误也不重发', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return streamThenFail('partial');
    }) as typeof fetch;

    const seen: string[] = [];
    await assert.rejects(
      () =>
        client().complete(messages, [], undefined, (delta) => {
          if (delta.text) seen.push(delta.text);
        }),
      /socket died/,
    );
    assert.deepEqual(seen, ['partial']);
    assert.equal(calls, 1, '既不能走重试，也不能走参数降级');
  });

  it('参数无关的 400 直接上抛', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return errorResponse(400, 'invalid model: nope');
    }) as typeof fetch;

    await assert.rejects(() => client().complete(messages, []), /LLM HTTP 400/);
    assert.equal(calls, 1);
  });

  it('上下文超窗仍以 ContextOverflowError 抛出，不被降级吞掉', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return errorResponse(400, "This model's maximum context length is 128000 tokens");
    }) as typeof fetch;

    await assert.rejects(
      () => client().complete(messages, []),
      (error: unknown) => error instanceof ContextOverflowError,
    );
    assert.equal(calls, 1);
  });
});

describe('会话缓存路由', () => {
  /** 与 stubFetch 同构，但额外记录请求头。 */
  function stubWithHeaders(
    bodies: Array<Record<string, unknown>>,
    headers: Array<Record<string, string>>,
  ): void {
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      const flat: Record<string, string> = {};
      const raw = new Headers(init.headers);
      raw.forEach((value, name) => {
        flat[name] = value;
      });
      headers.push(flat);
      return okResponse('ok');
    }) as typeof fetch;
  }

  it('sessionId 进请求体（key + retention）与亲和头', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const headers: Array<Record<string, string>> = [];
    stubWithHeaders(bodies, headers);

    const c = createSseClient(openaiAdapter, {
      baseUrl: 'http://example.invalid/v1',
      apiKey: 'k',
      model: 'gpt-4o',
      maxTokens: 100,
      sessionId: 'sess-abc',
    });
    await c.complete(messages, []);

    assert.equal(bodies[0]?.prompt_cache_key, 'sess-abc');
    assert.equal(bodies[0]?.prompt_cache_retention, '24h');
    assert.equal(headers[0]?.session_id, 'sess-abc');
    assert.equal(headers[0]?.['x-session-affinity'], 'sess-abc');
  });

  it('不传 sessionId 时不发缓存路由参数，行为与旧版一致', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const headers: Array<Record<string, string>> = [];
    stubWithHeaders(bodies, headers);

    await client().complete(messages, []);

    assert.equal(bodies[0]?.prompt_cache_key, undefined);
    assert.equal(headers[0]?.session_id, undefined);
    // retention 与路由无关（只要求端点把前缀缓存留久点），没有 key 也照发。
    assert.equal(bodies[0]?.prompt_cache_retention, '24h');
  });

  it('用户自定义头与亲和头同名时以用户为准', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const headers: Array<Record<string, string>> = [];
    stubWithHeaders(bodies, headers);

    const c = createSseClient(openaiAdapter, {
      baseUrl: 'http://example.invalid/v1',
      apiKey: 'k',
      model: 'gpt-4o',
      sessionId: 'sess-abc',
      headers: { session_id: 'mine' },
    });
    await c.complete(messages, []);
    assert.equal(headers[0]?.session_id, 'mine');
  });
});
