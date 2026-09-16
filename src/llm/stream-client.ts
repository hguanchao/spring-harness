import { degradeRequestCaps, initialRequestCaps, type RequestCaps } from './compat.js';
import type { ChatMessage, LlmClient, ReasoningEffort, RequestBodyOptions, StreamDelta } from './openai.js';
import { finishStream, newSseAcc, type SseAcc } from './openai.js';
import { postSseStream } from './sse.js';
import { RetryableError, withRetries } from './retry.js';
import { errorMessage } from '../util.js';

/** 一个上游协议的静态差异：端点、鉴权头、请求体编码、SSE 事件解码。 */
export interface ProtocolAdapter {
  path: string;
  headers(apiKey: string): Record<string, string>;
  /** caps 决定同一协议下随端点而变的参数形态（参数名、可选字段），见 compat.ts。 */
  buildBody(input: RequestBodyOptions, caps: RequestCaps): string;
  /** textDelta = 正文增量；thinkingDelta = 思考链增量（推理模型/扩展思考）。 */
  apply(payload: string, acc: SseAcc): { textDelta?: string; thinkingDelta?: string };
  /**
   * 会话亲和的追加请求头（OpenAI 系缓存路由用）。Anthropic 按账号 + 前缀计缓存，
   * 没有这类头，所以是可选的。
   */
  sessionHeaders?(sessionId: string, baseUrl: string): Record<string, string>;
  /**
   * 端点拒绝某个可选参数时的降级：从错误报文推断出新的能力位。
   * 返回 undefined 表示这不是参数容忍度问题，调用方按原错误抛出。
   */
  degrade?(caps: RequestCaps, errorText: string): RequestCaps | undefined;
}

export interface SseClientOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  maxTokens?: number;
  maxRetries?: number;
  /** 追加点静态请求头（如网关要求客户端标识）；与协议默认头同名时以它为准。 */
  headers?: Record<string, string>;
  /** Anthropic prompt-cache 断点开关（来自 config.prompt_cache，默认开）。 */
  promptCache?: boolean;
  /**
   * 会话身份：作为 OpenAI 系的 `prompt_cache_key` 与亲和头。
   * 省略（如独立测试）时不发缓存路由参数，行为与旧版一致。
   */
  sessionId?: string;
}

/**
 * 一次请求内允许的参数降级次数上限。
 *
 * 取值 8 ≥ 全部能力位的数量，够每个位各降一次。设上限是必要的：`max_tokens` 与
 * `max_completion_tokens` 两个方向都能被报文触发，端点若前后矛盾就会来回翻，
 * 无上限则变成死循环。降级只在「尚未向用户输出任何内容」时发生，所以最坏代价是
 * 多发几次必然失败的请求，不会产生重复内容。
 */
const MAX_DEGRADATIONS = 8;

/**
 * 三种协议共用的流式客户端。
 *
 * 两条不变量在这里：
 * 1. 一旦流出了文本或思考 delta 就绝不重试，否则用户会看到重复内容。因此 `withRetries`
 *    只覆盖「连接未建立 / 尚无输出」的失败，参数降级也一样受此约束。
 * 2. 参数降级的结果记在**闭包**里（一个 client ≈ 一个进程/会话），同一会话内换完就不再踩，
 *    不必每步重交一次学费。
 */
export function createSseClient(adapter: ProtocolAdapter, options: SseClientOptions): LlmClient {
  const url = `${options.baseUrl.replace(/\/$/, '')}${adapter.path}`;
  const headers: Record<string, string> = { ...adapter.headers(options.apiKey) };
  // 会话亲和头在用户自定义头**之前**：config.httpHeaders 与它们同名时以用户为准。
  if (options.sessionId !== undefined && adapter.sessionHeaders) {
    Object.assign(headers, adapter.sessionHeaders(options.sessionId, options.baseUrl));
  }
  Object.assign(headers, options.headers);
  // key 为空且由自定义头补位时是显式的免鉴权约定；此时任何形式的鉴权头都必须去掉，
  // 否则网关会走「校验这把空/无效 key」的路径，免鉴权会话永远到不了。
  if (!options.apiKey) {
    for (const name of Object.keys(headers)) {
      const lower = name.toLowerCase();
      if (lower === 'authorization' || lower === 'x-api-key') delete headers[name];
    }
  }
  const degrade = adapter.degrade ?? degradeRequestCaps;
  let caps: RequestCaps = initialRequestCaps(options.model, options.promptCache ?? true);

  return {
    async complete(
      messages: ChatMessage[],
      tools: unknown[],
      signal?: AbortSignal,
      onDelta?: (delta: { text?: string; thinking?: string }) => void,
    ): Promise<StreamDelta> {
      let streamed = false;
      const wrapped = onDelta
        ? (delta: { text?: string; thinking?: string }) => {
            // 思考链也算「已经给用户看过的东西」：此时再重试会让他看到重复的推理过程。
            streamed = true;
            onDelta(delta);
          }
        : undefined;

      const attempt = async (body: string): Promise<StreamDelta> => {
        const acc = newSseAcc();
        await postSseStream({
          url,
          headers,
          body,
          signal,
          onData: (payload) => {
            const { textDelta, thinkingDelta } = adapter.apply(payload, acc);
            if (textDelta || thinkingDelta) wrapped?.({ text: textDelta, thinking: thinkingDelta });
          },
        });
        return finishStream(acc);
      };

      for (let degradations = 0; ; ) {
        const body = adapter.buildBody(
          {
            model: options.model,
            messages,
            tools,
            reasoningEffort: options.reasoningEffort,
            maxTokens: options.maxTokens,
            sessionId: options.sessionId,
          },
          caps,
        );
        try {
          return await withRetries(
            () => attempt(body),
            (error: unknown) => !streamed && error instanceof RetryableError,
            { maxRetries: options.maxRetries, signal },
          );
        } catch (error) {
          // 已经输出过内容 / 已取消 / 降级次数用尽：原样上抛。
          if (streamed || signal?.aborted || degradations >= MAX_DEGRADATIONS) throw error;
          const next = degrade(caps, errorMessage(error));
          if (!next) throw error;
          caps = next;
          degradations++;
        }
      }
    },
  };
}

