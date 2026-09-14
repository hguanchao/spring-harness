import type { JsonlSession } from './store.js';

/** Markdown 导出：人可读优先，工具输出折叠进 <details> 避免刷屏。 */
export function exportMarkdown(session: JsonlSession): string {
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
export function exportJson(session: JsonlSession): string {
  return JSON.stringify(session.readAll(), null, 2);
}
