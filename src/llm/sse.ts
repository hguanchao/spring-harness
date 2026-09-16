// 流类型显式从 node:stream/web 取：新版 @types/node 收紧了全局 DOM 流类型，
// 依赖 lock 重算后全局名不再可用（教训：类型别依赖传递全局）。
import type { ReadableStreamDefaultReader, ReadableStreamReadResult } from 'node:stream/web';
import { errorMessage, flattenWhitespace } from '../util.js';
import { llmError } from './errors.js';
import { isRetryableStatus, RetryableError, retryAfterMs } from './retry.js';

/** 两次 SSE chunk 之间的默认空闲上限。交互 CLI 比 grok 的 300s 更短，避免 TUI 挂死。 */
export const SSE_IDLE_TIMEOUT_MS = 120_000;

export interface SseStreamParams {
  url: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
  /** 每收到一行 data payload（已剥掉 "data:" 前缀）回调一次；抛错即中断读取。 */
  onData: (payload: string) => void;
  /** 两次 chunk 间隔超时；<=0 关闭。默认 SSE_IDLE_TIMEOUT_MS。 */
  idleTimeoutMs?: number;
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
  if (!response.body) throw new Error('LLM response missing body');

  // 网关维护页常回 HTTP 200 + text/html：若不拦截会被当成「空成功」，TUI 无错误输出。
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
    const detail = flattenWhitespace((await response.text()).slice(0, 400));
    throw new Error(`LLM returned HTML instead of SSE (${contentType || 'unknown'}): ${detail}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const idleMs = params.idleTimeoutMs ?? SSE_IDLE_TIMEOUT_MS;
  let buffer = '';
  let sawData = false;
  let sample = '';
  try {
    for (;;) {
      const { value, done } = await readIdle(reader, idleMs);
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = done ? '' : (lines.pop() ?? '');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) {
          // 保留开头非 SSE 样本，流结束仍无 data: 时用于报错。
          if (!sawData && sample.length < 240) sample += `${trimmed}\n`;
          continue;
        }
        const payload = trimmed.slice(5).trim();
        if (!payload) continue;
        sawData = true;
        params.onData(payload);
      }
      if (done) break;
    }
    if (!sawData) {
      const hint = flattenWhitespace(sample) || '(empty body)';
      throw new Error(`LLM stream produced no SSE data events (${contentType || 'unknown content-type'}): ${hint.slice(0, 400)}`);
    }
  } finally {
    // 提前退出（idle 超时 / onData 抛错 / 取消）时流还没读完：不 cancel 的话 undici 会把这条
    // 连接一直占着直到超时。重试与参数降级都可能连发多次请求，泄漏会按请求数累积。
    void reader.cancel().catch(() => {
      // 流已出错时 cancel 也会 reject，这里只关心释放连接。
    });
  }
}
