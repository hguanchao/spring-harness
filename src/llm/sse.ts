// 流类型显式从 node:stream/web 取：新版 @types/node 收紧了全局 DOM 流类型，
// 依赖 lock 重算后全局名不再可用（教训：类型别依赖传递全局）。
import type { ReadableStreamDefaultReader, ReadableStreamReadResult } from 'node:stream/web';
import { errorMessage, flattenWhitespace } from '../util.js';
import { llmError } from './errors.js';
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

function deliverSseLine(line: string, onData: (payload: string) => void): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return false;
  const payload = trimmed.slice(5).trim();
  if (!payload) return false;
  onData(payload);
  return true;
}

export async function postSseStream(params: SseStreamParams): Promise<void> {
  let response: Response;
  try {
    response = await fetch(params.url, {
      method: 'POST',
      headers: params.headers,
      body: params.body,
      signal: params.signal,
    });
  } catch (error) {
    if (params.signal?.aborted) throw error;
    throw new RetryableError(`network error: ${errorMessage(error)}`);
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 400);
    if (isRetryableStatus(response.status)) {
      throw new RetryableError(
        `LLM HTTP ${response.status}: ${detail}`,
        response.status,
        retryAfterMs(response.headers.get('retry-after')),
      );
    }
    // 400/413 里可能是「上下文超窗」——那一种压缩后重试就能成功，必须让 loop 认得出来。
    throw llmError(`LLM HTTP ${response.status}`, detail);
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
  try {
    for (;;) {
      const waitMs = gotByte || idleMs <= 0 ? idleMs : Math.min(idleMs, firstByteMs);
      const { value, done } = await readIdle(reader, waitMs);
      if (value !== undefined && value.byteLength > 0) gotByte = true;
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      if (buffer.charCodeAt(0) === 0xfeff) buffer = buffer.slice(1);
      const lines = buffer.split(/\r?\n/);
      buffer = done ? '' : (lines.pop() ?? '');
      for (const line of lines) {
        if (deliverSseLine(line, params.onData)) {
          sawData = true;
          continue;
        }
        const trimmed = line.trim();
        if (!sawData && trimmed && sample.length < 256_000) sample += `${trimmed}\n`;
      }
      if (done) break;
    }
    if (!sawData) {
      const raw = sample.trim();
      if (raw.startsWith('{') || raw.startsWith('[')) {
        params.onData(raw);
        return;
      }
      throw emptyStreamError(contentType, flattenWhitespace(raw) || '(empty body)');
    }
  } finally {
    // 提前退出（idle 超时 / onData 抛错 / 取消）时流还没读完：不 cancel 的话 undici 会把这条
    // 连接一直占着直到超时。重试与参数降级都可能连发多次请求，泄漏会按请求数累积。
    void reader.cancel().catch(() => {
      // 流已出错时 cancel 也会 reject，这里只关心释放连接。
    });
  }
}
