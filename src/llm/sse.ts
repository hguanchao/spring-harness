// 流类型显式从 node:stream/web 取：新版 @types/node 收紧了全局 DOM 流类型，
// 依赖 lock 重算后全局名不再可用（教训：类型别依赖传递全局）。
import { Readable } from 'node:stream';
import type { ReadableStreamDefaultReader, ReadableStreamReadResult } from 'node:stream/web';
import { request as undiciRequest } from 'undici';
import { formatFetchError, flattenWhitespace } from '../util.js';
import { classifyHttpError, llmError } from './errors.js';
import { isRetryableStatus, RetryableError, retryAfterMs } from './retry.js';

/** 两次 SSE chunk 之间的默认空闲上限。交互 CLI 比 grok 的 300s 更短，避免 TUI 挂死。 */
export const SSE_IDLE_TIMEOUT_MS = 120_000;
/**
 * 首字节超时。实测网关常 200 + event-stream 然后挂到空体；用满 idle 120s 再重试，
 * 一轮工具后的下一跳会空等数分钟才报 empty body。首包更短，后续 chunk 仍用 idle。
 */
export const SSE_FIRST_BYTE_TIMEOUT_MS = 30_000;

export interface SseStreamParams {
  url: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
  /** 每收到一行 data payload（已剥掉 "data:" 前缀）回调一次；抛错即中断读取。 */
  onData: (payload: string) => void;
  /** 两次 chunk 间隔超时；<=0 关闭。默认 SSE_IDLE_TIMEOUT_MS。 */
  idleTimeoutMs?: number;
  /** 尚未读到任何字节时的超时；默认 SSE_FIRST_BYTE_TIMEOUT_MS。 */
  firstByteTimeoutMs?: number;
}

async function readIdle(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (idleMs <= 0) return reader.read();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new RetryableError(`LLM stream idle timeout (${idleMs}ms)`)),
          idleMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 三种上游协议（chat.completions / responses / messages）共用的 SSE POST 流。
 * 统一处理网络错误分类（可重试判定）、HTTP 状态码与按行分割；
 * 何时算"流完成"由各协议的 onData 消费者自行判断。
 */
/** 空流 / 空 JSON 是网关抖动（截图里的 empty body），对齐 deepseek-harness 的 EMPTY_RESPONSE：可重试。 */
function emptyStreamError(contentType: string, hint: string): RetryableError {
  return new RetryableError(
    `LLM stream produced no SSE data events (${contentType || 'unknown content-type'}): ${hint.slice(0, 400)}`,
  );
}

/** SSE 字段名大小写敏感；冒号后可选一个空格。 */
function sseField(line: string, name: string): string | undefined {
  if (!line.startsWith(name)) return undefined;
  if (line.length === name.length) return '';
  if (line[name.length] !== ':') return undefined;
  const value = line.slice(name.length + 1);
  return value.startsWith(' ') ? value.slice(1) : value;
}

/**
 * 把一帧 SSE 收成 adapter 能吃的 payload。
 *
 * grok-build / 官方 Responses 把事件名放在 `event:`，JSON 里未必再写 `type`。
 * 只认 `data:` 且强求 `[DONE]` 时，中转站正常关流就会报 STREAM_CLOSED。
 */
function materializeSse(event: string | undefined, data: string): string | undefined {
  const payload = data.trim();
  const kind = event?.trim();
  if (payload === '[DONE]' || kind === '[DONE]') return '[DONE]';
  if (payload) {
    if (!kind || !payload.startsWith('{')) return payload;
    try {
      const row = JSON.parse(payload) as Record<string, unknown>;
      if (row && typeof row === 'object' && !Array.isArray(row) && typeof row.type !== 'string') {
        row.type = kind;
        return JSON.stringify(row);
      }
    } catch {
      return payload;
    }
    return payload;
  }
  if (kind === 'response.completed' || kind === 'response.incomplete' || kind === 'response.failed' || kind === 'message_stop') {
    return JSON.stringify({ type: kind });
  }
  return undefined;
}

function looksLikeJsonValue(line: string): boolean {
  if (!(line.startsWith('{') || line.startsWith('['))) return false;
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

/** 测试 mock 的是 globalThis.fetch；正式请求走 undici，避免 fetch 丢掉 User-Agent。 */
async function postLlm(params: SseStreamParams): Promise<Response> {
  if (process.env.NODE_TEST_CONTEXT) {
    return fetch(params.url, {
      method: 'POST',
      headers: params.headers,
      body: params.body,
      signal: params.signal,
    });
  }
  const res = await undiciRequest(params.url, {
    method: 'POST',
    headers: params.headers,
    body: params.body,
    signal: params.signal,
  });
  const headerInit: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headerInit.push([name, item]);
    else headerInit.push([name, value]);
  }
  return new Response(Readable.toWeb(res.body), {
    status: res.statusCode,
    headers: headerInit,
  });
}

export async function postSseStream(params: SseStreamParams): Promise<void> {
  let response: Response;
  try {
    response = await postLlm(params);
  } catch (error) {
    if (params.signal?.aborted) throw error;
    throw new RetryableError(`network error: ${formatFetchError(error)}`);
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 400);
    const code = classifyHttpError(response.status, detail);
    // 超窗先于否决判定：压缩重试走的是另一条恢复路径，与传输重试的预算无关。
    if (code === 'CONTEXT_WINDOW_EXCEEDED') throw llmError(`LLM HTTP ${response.status}`, detail);
    // 网关显式说别重试（x-should-retry: false，OpenAI/Anthropic SDK 同语义）就尊重：
    // 硬按状态码白名单重试只会白烧 max_retries 轮。
    if (response.headers.get('x-should-retry') !== 'false' && isRetryableStatus(response.status) && code !== 'QUOTA') {
      throw new RetryableError(
        `LLM HTTP ${response.status} [${code}]: ${detail}`,
        response.status,
        retryAfterMs(response.headers.get('retry-after')),
      );
    }
    throw llmError(`LLM HTTP ${response.status} [${code}]`, detail);
  }
  if (!response.body) throw new RetryableError('LLM response missing body');

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
    const detail = flattenWhitespace((await response.text()).slice(0, 400));
    throw new RetryableError(`LLM returned HTML instead of SSE (${contentType || 'unknown'}): ${detail}`);
  }

  // 网关忽略 stream:true 时会给一条完整 JSON。按 SSE 去拆会得到「空 data:」，
  // 必须整段交给 adapter（chat.completions 的 message / Anthropic 的 type=message）。
  if (contentType.includes('application/json') && !contentType.includes('event-stream')) {
    const raw = (await response.text()).trim();
    if (!raw) throw emptyStreamError(contentType, '(empty body)');
    params.onData(raw);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const idleMs = params.idleTimeoutMs ?? SSE_IDLE_TIMEOUT_MS;
  const firstByteMs = params.firstByteTimeoutMs ?? SSE_FIRST_BYTE_TIMEOUT_MS;
  let buffer = '';
  let sawData = false;
  let sample = '';
  let gotByte = false;
  let eventName: string | undefined;
  let dataLines: string[] = [];
  const emit = (payload: string): void => {
    params.onData(payload);
    sawData = true;
  };
  const dispatch = (): void => {
    const payload = materializeSse(eventName, dataLines.join('\n'));
    eventName = undefined;
    dataLines = [];
    if (payload !== undefined) emit(payload);
  };
  const handleLine = (line: string): void => {
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    const event = sseField(line, 'event');
    if (event !== undefined) {
      eventName = event;
      return;
    }
    const data = sseField(line, 'data');
    if (data !== undefined) {
      dataLines.push(data);
      return;
    }
    if (sseField(line, 'id') !== undefined || sseField(line, 'retry') !== undefined) return;
    const trimmed = line.trim();
    if (looksLikeJsonValue(trimmed)) {
      emit(trimmed);
      return;
    }
    if (!sawData && trimmed && sample.length < 256_000) sample += `${trimmed}\n`;
  };
  try {
    for (;;) {
      const waitMs = gotByte || idleMs <= 0 ? idleMs : Math.min(idleMs, firstByteMs);
      const { value, done } = await readIdle(reader, waitMs);
      if (value !== undefined && value.byteLength > 0) gotByte = true;
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      if (buffer.charCodeAt(0) === 0xfeff) buffer = buffer.slice(1);
      const lines = buffer.split(/\r?\n/);
      buffer = done ? '' : (lines.pop() ?? '');
      for (const line of lines) handleLine(line);
      if (done) {
        dispatch();
        break;
      }
    }
    if (!sawData) {
      const raw = sample.trim();
      if (raw.startsWith('{') || raw.startsWith('[')) {
        params.onData(raw);
        return;
      }
      throw emptyStreamError(contentType, flattenWhitespace(raw) || '(empty body)');
    }
    // 有 data 就收工。`[DONE]` 只是 chat.completions 习惯哨兵，Responses /
    // Anthropic / 中转站经常直接关连接。真断流走 idle timeout 或 fetch 失败。
  } finally {
    // 提前退出（idle 超时 / onData 抛错 / 取消）时流还没读完：不 cancel 的话 undici 会把这条
    // 连接一直占着直到超时。重试与参数降级都可能连发多次请求，泄漏会按请求数累积。
    void reader.cancel().catch(() => {
      // 流已出错时 cancel 也会 reject，这里只关心释放连接。
    });
  }
}
