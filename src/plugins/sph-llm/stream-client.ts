import {
  degradeRequestCaps,
  initialRequestCaps,
  type CompatProfile,
  type RequestCaps,
  type SessionAffinityFormat,
} from './compat.js';
import { ContextOverflowError } from './errors.js';
import type { ChatMessage, LlmClient, LlmRetryInfo, ModelCostRates, ReasoningEffort, RequestBodyOptions, StreamDelta } from './openai.js';
import { costUsd, finishStream, isEmptyReply, newSseAcc, toolArgumentsIncomplete, type SseAcc } from './openai.js';
import { FatalStreamError, postSseStream } from './sse.js';
import { backoffMs, DEFAULT_MAX_RETRIES, RetryableError, sleepAbortable } from './retry.js';
import { errorMessage } from '../../util.js';

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
  /**
   * models.json 里的请求头，原样附上。与协议默认头同名时以它为准。
   */
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
  /** 模型声明的单价；缺席则 usage 不折算 costUsd。 */
  costRates?: ModelCostRates;
  /** 模型是否接受图片输入。`false` 时图片部件在请求体里降级成说明文本。 */
  supportsImages?: boolean;
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

/** 半截里如果夹着没闭合的工具参数，不能交给循环去执行。 */
function usablePartial(partial: StreamDelta): boolean {
  return !isEmptyReply(partial) && !toolArgumentsIncomplete(partial);
}

/**
 * 三种协议共用的流式客户端。
 *
 * 两条不变量在这里：
 * 1. 还没流出任何内容时，传输失败整段重试。已经有正文、思考或完整工具参数时，
 *    把半截交回循环：结束原因缺省标成 unknown，循环会续写，而不是把同一段再流一遍。
 *    工具参数若是没闭合的 JSON，不当成一次调用：重试整段请求。
 *    参数降级只在尚未向用户输出任何内容时发生。
 * 2. 参数降级的结果记在**闭包**里（一个 client ≈ 一个进程/会话），同一会话内换完就不再踩，
 *    不必每步重交一次学费。
 */
export function createSseClient(adapter: ProtocolAdapter, options: SseClientOptions): LlmClient {
  const url = `${options.baseUrl.replace(/\/$/, '')}${adapter.path}`;
  const headers: Record<string, string> = { ...adapter.headers(options.apiKey) };
  // 不按主机猜亲和头。只有 models.json 的 compat.session_affinity 点了名字才发。
  const sessionAffinity = options.compat?.sessionAffinity ?? 'off';
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
  // 单价声明了才折算：usage 上没有 costUsd 就意味着「不知道价格」，与 $0 是两回事。
  const price = (delta: StreamDelta): StreamDelta => {
    if (!delta.usage || !options.costRates) return delta;
    return { ...delta, usage: { ...delta.usage, costUsd: costUsd(delta.usage, options.costRates) } };
  };

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
            // 随机模板每次请求现展开：重试也拿新 id，不带上一次的会话/请求身份。
            headers,
            body,
            signal,
            onData: (payload) => {
              const { textDelta, thinkingDelta } = adapter.apply(payload, acc);
              if (textDelta || thinkingDelta) wrapped?.({ text: textDelta, thinking: thinkingDelta });
            },
          });
        } catch (error) {
          if (signal?.aborted) throw error;
          if (error instanceof ContextOverflowError) throw error;
          if (error instanceof FatalStreamError) throw error.cause;
          // 审核、鉴权这类终态不是 RetryableError，原样上抛。
          // 瞬时断流且累积器里已经有内容：交回半截。结束原因还空着就标 unknown，
          // 循环据此续写，而不是把已经上屏的字再流一遍。
          const partial = finishStream(acc);
          if (error instanceof RetryableError && usablePartial(partial)) {
            return price({ ...partial, finishReason: partial.finishReason ?? 'unknown' });
          }
          throw error;
        }
        const result = price(finishStream(acc));
        // 正常结束但零内容按空回复处理，重试同一请求，
        // 不要当成成功空回复让 loop 收工（截图里工具跑完下一跳空体就是这条路径）。
        // 工具参数没写完同样重试：交回去只会变成 invalid tool arguments。
        if (isEmptyReply(result) || toolArgumentsIncomplete(result)) {
          throw new RetryableError('LLM returned a completed response with no usable content');
        }
        return result;
      };

      const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
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
            supportsImages: options.supportsImages,
          },
          caps,
        );
        try {
          return await attempt(body);
        } catch (error) {
          if (signal?.aborted) throw error;
          // 参数降级只在还没给用户看过任何增量时做；已经流过思考/正文就只走传输重试。
          const text = errorMessage(error);
          const next = streamed || degradations >= MAX_DEGRADATIONS ? undefined : degrade(caps, text);
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
          if (!(error instanceof RetryableError) || transportTries >= maxRetries) {
            throw error;
          }
          transportTries++;
          onRetry?.({
            attempt: transportTries + 1,
            message: text,
            kind: 'transport',
            maxRetries,
          });
          await sleepAbortable(backoffMs(transportTries - 1), signal);
        }
      }
    },
  };
}

