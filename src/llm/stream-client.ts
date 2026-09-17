import {
  degradeRequestCaps,
  degradeSilentCompat,
  detectSessionAffinity,
  initialRequestCaps,
  type CompatProfile,
  type RequestCaps,
  type SessionAffinityFormat,
} from './compat.js';
import { ContextOverflowError } from './errors.js';
import type { ChatMessage, LlmClient, LlmRetryInfo, ReasoningEffort, RequestBodyOptions, StreamDelta } from './openai.js';
import { finishStream, isEmptyReply, newSseAcc, type SseAcc } from './openai.js';
import { postSseStream } from './sse.js';
import { backoffMs, RetryableError, sleepAbortable, StreamClosedError } from './retry.js';
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
   * 没有这类头，所以是可选的。格式由 URL 推断或 `[compat].session_affinity` 覆盖。
   */
  sessionHeaders?(sessionId: string, format: SessionAffinityFormat): Record<string, string>;
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
  /** `[compat]` 声明，覆盖 URL 推断。 */
  compat?: CompatProfile;
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

/** 空 SSE / 空完成：再发同一份请求没有意义，应立刻降级字段而不是连打 8 次。 */
function isSilentReject(error: unknown): boolean {
  return error instanceof RetryableError && /no SSE data events|no content/.test(error.message);
}

/**
 * 三种协议共用的流式客户端。
 *
 * 两条不变量在这里：
 * 1. 传输失败不提交半截（对齐 dsh：failed chunks 不进会话，同一步再打）。
 *    思考或正文已经上屏也一样——重试会再流一遍，TUI 可能短暂重复，但不会留下空 assistant。
 *    参数降级只在尚未向用户输出任何内容时发生。
 * 2. 参数降级的结果记在**闭包**里（一个 client ≈ 一个进程/会话），同一会话内换完就不再踩，
 *    不必每步重交一次学费。
 */
export function createSseClient(adapter: ProtocolAdapter, options: SseClientOptions): LlmClient {
  const url = `${options.baseUrl.replace(/\/$/, '')}${adapter.path}`;
  const headers: Record<string, string> = { ...adapter.headers(options.apiKey) };
  const sessionAffinity = options.compat?.sessionAffinity ?? detectSessionAffinity(options.baseUrl);
  // 会话亲和头在用户自定义头**之前**：config.httpHeaders 与它们同名时以用户为准。
  if (options.sessionId !== undefined && adapter.sessionHeaders) {
    Object.assign(headers, adapter.sessionHeaders(options.sessionId, sessionAffinity));
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
  let caps: RequestCaps = initialRequestCaps(options.model, options.promptCache ?? true, {
    baseUrl: options.baseUrl,
    compat: options.compat,
  });

  return {
    async complete(
      messages: ChatMessage[],
      tools: unknown[],
      signal?: AbortSignal,
      onDelta?: (delta: { text?: string; thinking?: string }) => void,
      onRetry?: (info: LlmRetryInfo) => void,
    ): Promise<StreamDelta> {
      let streamed = false;
      const wrapped = onDelta
        ? (delta: { text?: string; thinking?: string }) => {
            streamed = true;
            onDelta(delta);
          }
        : undefined;

      const attempt = async (body: string): Promise<StreamDelta> => {
        const acc = newSseAcc();
        try {
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
        } catch (error) {
          // 半截流已经上屏：丢掉再报错就是「突然中断」。只对瞬时传输错误交回半截，
          // 让 loop 再打一轮。协议层 error 事件（审核拒绝、上游业务失败）必须上抛，
          // 否则会把失败当成 stop 收工。
          if (signal?.aborted) throw error;
          if (error instanceof ContextOverflowError) throw error;
          throw error;
        }
        const result = finishStream(acc);
        // 对齐 deepseek-harness：正常结束但零内容是 EMPTY_RESPONSE，重试同一请求，
        // 不要当成成功空回复让 loop 收工（截图里工具跑完下一跳空体就是这条路径）。
        if (isEmptyReply(result)) {
          throw new RetryableError('LLM returned a completed response with no content');
        }
        return result;
      };

      const maxRetries = options.maxRetries ?? 8;
      let transportTries = 0;
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
          return await attempt(body);
        } catch (error) {
          if (signal?.aborted) throw error;
          // 参数降级只在还没给用户看过任何增量时做；已经流过思考/正文就只走传输重试。
          const text = errorMessage(error);
          const next = streamed
            ? undefined
            : degrade(caps, text)
              ?? (isSilentReject(error) && degradations < MAX_DEGRADATIONS
                ? degradeSilentCompat(caps)
                : undefined);
          if (next) {
            onRetry?.({
              attempt: degradations + 2,
              message: `${text}; dropping extra request fields`,
              kind: 'compat',
            });
            caps = next;
            degradations++;
            continue;
          }
          // 字段已经剥完：空 SSE 按传输抖动退避，不再立刻失败。
          if (error instanceof StreamClosedError || !(error instanceof RetryableError) || transportTries >= maxRetries) {
            throw error;
          }
          transportTries++;
          onRetry?.({ attempt: transportTries + 1, message: text, kind: 'transport' });
          await sleepAbortable(backoffMs(transportTries - 1), signal);
        }
      }
    },
  };
}

