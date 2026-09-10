import { asString, clip, type ToolContext, type ToolResult, type ToolSpec } from './types.js';

export const webFetchTool: ToolSpec = {
  name: 'web_fetch',
  description: 'HTTP GET a URL and return text. No search index. Use for docs you already have a URL for.',
  schema: {
    type: 'object',
    properties: { url: { type: 'string' } },
    required: ['url'],
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const url = asString(args, 'url');
    if (!/^https?:\/\//i.test(url)) return { ok: false, content: 'url must be http(s)' };
    const allowed = await ctx.approve('web_fetch', url);
    if (!allowed) return { ok: false, content: 'web_fetch denied' };
    const response = await fetch(url, { signal: ctx.signal, redirect: 'follow' });
    const text = await response.text();
    return { ok: response.ok, content: clip(`HTTP ${response.status}\n${text}`, 24_000) };
  },
};
