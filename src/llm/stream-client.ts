import type { ChatMessage, LlmClient, ReasoningEffort, RequestBodyOptions, StreamDelta } from './openai.js';
import { finishStream, newSseAcc, type SseAcc } from './openai.js';
import { postSseStream } from './sse.js';
import { RetryableError, withRetries } from './retry.js';

/** 一个上游协议的静态差异：端点、鉴权头、请求体编码、SSE 事件解码。 */
export interface ProtocolAdapter {
  path: string;
  headers(apiKey: string): Record<string, string>;
  buildBody(input: RequestBodyOptions): string;
  apply(payload: string, acc: SseAcc): { textDelta?: string };
}

export interface SseClientOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  maxTokens?: number;
  maxRetries?: number;
}

/**
 * 三种协议共用的流式客户端。
 *
 * 唯一的不变量在这里：一旦流出了文本 delta 就绝不重试，否则用户会看到重复内容。
 * 因此重试只覆盖「连接未建立 / 尚无输出」的失败，半途断流仍然抛错。
 */
export function createSseClient(adapter: ProtocolAdapter, options: SseClientOptions): LlmClient {
  const url = `${options.baseUrl.replace(/\/$/, '')}${adapter.path}`;
  const headers = adapter.headers(options.apiKey);

  return {
    async complete(
      messages: ChatMessage[],
      tools: unknown[],
      signal?: AbortSignal,
      onDelta?: (delta: { text: string }) => void,
    ): Promise<StreamDelta> {
      const body = adapter.buildBody({
        model: options.model,
        messages,
        tools,
        reasoningEffort: options.reasoningEffort,
        maxTokens: options.maxTokens,
      });
      let streamed = false;
      const wrapped = onDelta
        ? (delta: { text: string }) => {
            streamed = true;
            onDelta(delta);
          }
        : undefined;

      const attempt = async (): Promise<StreamDelta> => {
        const acc = newSseAcc();
        await postSseStream({
          url,
          headers,
          body,
          signal,
          onData: (payload) => {
            const { textDelta } = adapter.apply(payload, acc);
            if (textDelta) wrapped?.({ text: textDelta });
          },
        });
        return finishStream(acc);
      };

      return withRetries(
        attempt,
        (error: unknown) => !streamed && error instanceof RetryableError,
        { maxRetries: options.maxRetries, signal },
      );
    },
  };
}
