/**
 * 远程 MCP：可流式 HTTP，以及旧的 HTTP+SSE。
 *
 * HTTP 把每条 JSON-RPC POST 到同一个 url，应答在这次响应里（JSON 或 SSE），
 * 会话号放在 `Mcp-Session-Id`。SSE 先 GET 等 `endpoint` 事件，再把消息 POST 到那个地址，
 * 应答从原来的事件流回来。两套都不能换成对方：混用会握手成功、调用全部超时。
 */

export interface JsonRpcMessage {
  jsonrpc?: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
}

export interface SseFrame {
  event: string;
  data: string;
}

export interface RemoteLink {
  write(message: JsonRpcMessage): void;
  close(): void;
  alive(): boolean;
  open(): Promise<void>;
}

export interface RemoteLinkOptions {
  url: string;
  headers?: Record<string, string>;
  /** 单次 POST / 等待 endpoint 的上限，与 hub 的请求超时对齐。 */
  timeoutMs?: number;
  onMessage: (message: JsonRpcMessage) => void;
  onRequestError: (id: number | undefined, error: Error) => void;
  onClose: (reason: string) => void;
}

const USER_AGENT = 'sph/0.1.0';

/** 把缓冲里已经以空行结束的 SSE 帧切出来，半帧留在 rest。 */
export function consumeSse(buffer: string): { frames: SseFrame[]; rest: string } {
  const normalized = buffer.replaceAll('\r\n', '\n');
  const frames: SseFrame[] = [];
  let rest = normalized;
  let splitAt = rest.indexOf('\n\n');
  while (splitAt >= 0) {
    const raw = rest.slice(0, splitAt);
    rest = rest.slice(splitAt + 2);
    let event = 'message';
    const data: string[] = [];
    for (const line of raw.split('\n')) {
      if (line === '' || line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice('event:'.length).trimStart();
      else if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart());
    }
    if (data.length > 0 || event !== 'message') frames.push({ event, data: data.join('\n') });
    splitAt = rest.indexOf('\n\n');
  }
  return { frames, rest };
}

export function openHttpLink(options: RemoteLinkOptions): RemoteLink {
  return new HttpLink(options);
}

export function openSseLink(options: RemoteLinkOptions): RemoteLink {
  return new SseLink(options);
}

function baseHeaders(extra: Record<string, string> | undefined): Headers {
  const headers = new Headers();
  headers.set('user-agent', USER_AGENT);
  for (const [key, value] of Object.entries(extra ?? {})) headers.set(key, value);
  return headers;
}

function clip(text: string): string {
  return text.length <= 200 ? text : text.slice(0, 200);
}

function deliverJson(text: string, onMessage: (message: JsonRpcMessage) => void): void {
  const trimmed = text.trim();
  if (trimmed === '') return;
  const parsed: unknown = JSON.parse(trimmed);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of list) onMessage(item as JsonRpcMessage);
}

class HttpLink implements RemoteLink {
  private sessionId: string | undefined;
  private readonly abort = new AbortController();
  private closed = false;
  private readonly timeoutMs: number;

  constructor(private readonly options: RemoteLinkOptions) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  open(): Promise<void> {
    return Promise.resolve();
  }

  alive(): boolean {
    return !this.closed;
  }

  close(): void {
    this.closed = true;
    this.abort.abort();
  }

  write(message: JsonRpcMessage): void {
    void this.post(message).catch((error: unknown) => {
      if (this.closed) return;
      const wrapped = error instanceof Error ? error : new Error(String(error));
      this.options.onRequestError(message.id, wrapped);
    });
  }

  private async post(message: JsonRpcMessage): Promise<void> {
    const headers = baseHeaders(this.options.headers);
    headers.set('content-type', 'application/json');
    headers.set('accept', 'application/json, text/event-stream');
    headers.set('mcp-protocol-version', '2025-03-26');
    if (this.sessionId !== undefined) headers.set('mcp-session-id', this.sessionId);
    const response = await fetch(this.options.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(message),
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(this.timeoutMs)]),
    });
    const session = response.headers.get('mcp-session-id');
    if (session !== null && session !== '') this.sessionId = session;
    if (response.status === 202 || response.status === 204) return;
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${clip(await response.text())}`);
    }
    const type = response.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream')) {
      await readEventStream(response.body, this.abort.signal, (frame) => {
        if (frame.data === '') return;
        deliverJson(frame.data, this.options.onMessage);
      });
      return;
    }
    deliverJson(await response.text(), this.options.onMessage);
  }
}

class SseLink implements RemoteLink {
  private postUrl: string | undefined;
  private readonly abort = new AbortController();
  private closed = false;
  private down = false;
  private readonly timeoutMs: number;
  private opened: Promise<void> = Promise.resolve();

  constructor(private readonly options: RemoteLinkOptions) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  alive(): boolean {
    return !this.closed && !this.down && this.postUrl !== undefined;
  }

  close(): void {
    this.closed = true;
    this.abort.abort();
  }

  open(): Promise<void> {
    this.opened = this.connect();
    return this.opened;
  }

  write(message: JsonRpcMessage): void {
    const postUrl = this.postUrl;
    if (postUrl === undefined) {
      this.options.onRequestError(message.id, new Error('SSE endpoint is not ready'));
      return;
    }
    void this.post(postUrl, message).catch((error: unknown) => {
      if (this.closed) return;
      const wrapped = error instanceof Error ? error : new Error(String(error));
      this.options.onRequestError(message.id, wrapped);
    });
  }

  private async connect(): Promise<void> {
    const headers = baseHeaders(this.options.headers);
    headers.set('accept', 'text/event-stream');
    // 这条 GET 要活过整个会话，不能套单次超时；超时只卡「迟迟不给 endpoint」。
    const response = await fetch(this.options.url, { headers, signal: this.abort.signal });
    if (!response.ok || response.body === null) {
      throw new Error(`HTTP ${response.status}: ${clip(await response.text())}`);
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('SSE endpoint timeout')), this.timeoutMs);
      void readEventStream(response.body, this.abort.signal, (frame) => {
        if (frame.event === 'endpoint' && this.postUrl === undefined) {
          this.postUrl = new URL(frame.data.trim(), this.options.url).toString();
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          resolve();
          return;
        }
        if (frame.data === '') return;
        try {
          deliverJson(frame.data, this.options.onMessage);
        } catch {
          // 半条或非 JSON 的事件不当成协议失败；下一条还能用。
        }
      }).then(() => {
        if (timer !== undefined) clearTimeout(timer);
        if (this.closed) return;
        this.down = true;
        const reason = 'SSE stream closed';
        if (!settled) reject(new Error(reason));
        else this.options.onClose(reason);
      }).catch((error: unknown) => {
        if (timer !== undefined) clearTimeout(timer);
        if (this.closed) return;
        this.down = true;
        const wrapped = error instanceof Error ? error : new Error(String(error));
        if (!settled) reject(wrapped);
        else this.options.onClose(wrapped.message);
      });
    });
    await ready;
  }

  private async post(postUrl: string, message: JsonRpcMessage): Promise<void> {
    const headers = baseHeaders(this.options.headers);
    headers.set('content-type', 'application/json');
    const response = await fetch(postUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(message),
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(this.timeoutMs)]),
    });
    if (response.status === 202 || response.status === 204 || response.ok) return;
    throw new Error(`HTTP ${response.status}: ${clip(await response.text())}`);
  }
}

async function readEventStream(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  onFrame: (frame: SseFrame) => void,
): Promise<void> {
  if (body === null) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let rest = '';
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += decoder.decode(value, { stream: true });
      const consumed = consumeSse(rest);
      rest = consumed.rest;
      for (const frame of consumed.frames) onFrame(frame);
    }
  } finally {
    reader.releaseLock();
  }
}
