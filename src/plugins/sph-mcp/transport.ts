/**
 * 传输选择。
 *
 * 显式 `transport` / `type` 优先（stdio、http、sse，以及 streamable-http 这个别名）。
 * 只有 url 时：路径以 `/sse` 结尾走旧 SSE，否则走可流式 HTTP。这和常见托管端点的写法一致，
 * 也和 grok 把 `--transport http` 与 `--transport sse` 分开的原因一样——两种线协议不能混用。
 */

export type McpTransportName = 'stdio' | 'http' | 'sse';

export function normalizeTransport(value: string | undefined): McpTransportName | 'invalid' | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  switch (value.trim().toLowerCase()) {
    case 'stdio':
      return 'stdio';
    case 'http':
    case 'streamable-http':
    case 'streamable_http':
      return 'http';
    case 'sse':
      return 'sse';
    default:
      return 'invalid';
  }
}

export function resolveTransport(spec: {
  command?: string;
  url?: string;
  transport?: string;
}): { transport: McpTransportName; invalid?: string } {
  const explicit = normalizeTransport(spec.transport);
  if (explicit === 'invalid') {
    return { transport: spec.url ? 'http' : 'stdio', invalid: spec.transport?.trim() };
  }
  if (explicit !== undefined) return { transport: explicit };
  if (spec.url) {
    try {
      const path = new URL(spec.url).pathname.replace(/\/+$/, '');
      if (path.endsWith('/sse')) return { transport: 'sse' };
    } catch {
      return { transport: 'http' };
    }
    return { transport: 'http' };
  }
  return { transport: 'stdio' };
}
