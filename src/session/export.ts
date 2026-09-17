import type { SessionPort } from './types.js';

/** Markdown 导出：人可读优先，工具输出折叠进 <details> 避免刷屏。 */
export function exportMarkdown(session: SessionPort): string {
  const parts: string[] = [`# sph session ${session.id}`, ''];
  for (const row of session.readMessages()) {
    if (row.role === 'user') {
      parts.push(`## user`, '', row.content, '');
      continue;
    }
    if (row.role === 'assistant') {
      const calls = row.toolCalls?.map((call) => call.name).join(', ');
      parts.push('## assistant', '', row.content || (calls ? `_(calling ${calls})_` : ''), '');
      continue;
    }
    if (row.role === 'tool') {
      parts.push(`<details><summary>tool: ${row.toolName ?? '?'}</summary>`, '', '```', row.content, '```', '', '</details>', '');
    }
  }
  return parts.join('\n');
}

/** JSON 导出：逐条原始记录（含事件），供外部程序做分析。 */
export function exportJson(session: SessionPort): string {
  return JSON.stringify(session.readAll(), null, 2);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 单文件 HTML：不依赖外链，方便把一轮对话存档。 */
export function exportHtml(session: SessionPort): string {
  const blocks: string[] = [];
  for (const row of session.readMessages()) {
    const role = escapeHtml(row.role);
    const body = escapeHtml(row.content);
    blocks.push(`<article class="${role}"><h2>${role}</h2><pre>${body}</pre></article>`);
  }
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>sph ${escapeHtml(session.id)}</title>
<style>
body{font:14px/1.5 ui-sans-serif,system-ui;background:#141414;color:#c6c6c6;max-width:52rem;margin:2rem auto;padding:0 1rem}
h1{color:#9d7cd8} article{margin:1.5rem 0;padding:1rem;background:#242424;border-radius:8px}
pre{white-space:pre-wrap;word-break:break-word} .tool{opacity:.85}
</style></head><body>
<h1>sph session ${escapeHtml(session.id)}</h1>
${blocks.join('\n')}
</body></html>
`;
}
