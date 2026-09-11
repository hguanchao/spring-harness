import { llmError } from './errors.js';
import { isRetryableStatus, RetryableError, retryAfterMs } from './retry.js';

export interface SseStreamParams {
  url: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
  /** 每收到一行 data payload（已剥掉 "data:" 前缀）回调一次；抛错即中断读取。 */
  onData: (payload: string) => void;
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
    throw new RetryableError(`network error: ${error instanceof Error ? error.message : String(error)}`);
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
    const detail = (await response.text()).slice(0, 400).replace(/\s+/g, ' ').trim();
    throw new Error(`LLM returned HTML instead of SSE (${contentType || 'unknown'}): ${detail}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawData = false;
  let sample = '';
  for (;;) {
    const { value, done } = await reader.read();
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
    const hint = sample.replace(/\s+/g, ' ').trim() || '(empty body)';
    throw new Error(`LLM stream produced no SSE data events (${contentType || 'unknown content-type'}): ${hint.slice(0, 400)}`);
  }
}
