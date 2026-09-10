/**
 * LLM 请求重试策略。
 *
 * 与参考实现（grok 默认 15 次、dsh 指数退避落盘）不同：sph 是交互优先的
 * harness，TUI 用户在等流式输出，重试预算给小（3 次、总等待 <6s）。
 * 已开始流式输出后不重试，避免向用户重复吐字。
 */
export interface RetryOptions {
  /** 最多重试次数（不含首次）。默认 3。 */
  maxRetries?: number;
  /** 退避基准毫秒。默认 500，指数递增并加抖动。 */
  baseDelayMs?: number;
}

export class RetryableError extends Error {
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = 'RetryableError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** 429/408/5xx 与网络层异常可重试；鉴权、参数类 4xx 重试无意义。 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, Math.min(date - Date.now(), 30_000));
  return undefined;
}

export function backoffMs(attempt: number, base = 500, hint?: number): number {
  if (hint !== undefined) return hint;
  const jitter = Math.floor(Math.random() * base * 0.25);
  return Math.min(base * 2 ** attempt + jitter, 10_000);
}

/** 可被 AbortSignal 打断的 sleep；被中止时直接抛出，不进入下一轮重试。 */
export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    function finish(): void {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function withRetries<T>(
  task: (attempt: number) => Promise<T>,
  shouldRetry: (error: unknown) => boolean,
  options?: RetryOptions & { signal?: AbortSignal },
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 3;
  const base = options?.baseDelayMs ?? 500;
  for (let attempt = 0; ; attempt++) {
    try {
      return await task(attempt);
    } catch (error) {
      if (attempt >= maxRetries || !shouldRetry(error) || options?.signal?.aborted) throw error;
      const hint = error instanceof RetryableError ? error.retryAfterMs : undefined;
      await sleepAbortable(backoffMs(attempt, base, hint), options?.signal);
    }
  }
}
