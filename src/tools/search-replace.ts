import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { assertInsideWorkspace, looksLikeText, TEXT_SNIFF_BYTES, toWorkspaceRelative } from '../workspace/boundary.js';
import { asOptionalBool, asString, asStringOrEmpty, guardReadOnlyWrite, type ToolContext, type ToolResult, type ToolSpec } from './types.js';

export const searchReplaceTool: ToolSpec = {
  name: 'search_replace',
  description: 'Replace an exact old_string in a workspace file — not sed or awk. old_string must match exactly once: when it is ambiguous, add surrounding lines to make it unique, or set replace_all to change every occurrence. The line-number prefix shown by read_file is not part of the file — match only the content after it.',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
      replace_all: { type: 'boolean' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const rel = asString(args, 'path');
    const denial = await guardReadOnlyWrite(ctx, rel, 'search_replace');
    if (denial) return denial;
    const oldString = asString(args, 'old_string');
    const newString = asStringOrEmpty(args, 'new_string');
    const replaceAll = asOptionalBool(args, 'replace_all');
    const abs = assertInsideWorkspace(ctx.workspaceRoot, rel);
    if (!existsSync(abs)) return { ok: false, content: `file not found: ${rel}` };
    const raw = readFileSync(abs);
    if (!looksLikeText(abs, raw.subarray(0, TEXT_SNIFF_BYTES))) return { ok: false, content: `refused binary file: ${rel}` };
    const text = raw.toString('utf8');
    // 用 indexOf 计数：旧实现 split(oldString) 会为一次计数分配「所有出现位置」的数组，
    // 在大文件里替换常见子串时内存开销与出现次数成正比。
    const first = text.indexOf(oldString);
    if (first < 0) return { ok: false, content: 'old_string not found' };
    let count = 1;
    for (let at = text.indexOf(oldString, first + oldString.length); at >= 0; at = text.indexOf(oldString, at + oldString.length)) {
      count++;
    }
    if (count > 1 && !replaceAll) {
      return { ok: false, content: `old_string matched ${count} times; pass replace_all or make it unique` };
    }
    const next = replaceAll
      ? text.replaceAll(oldString, newString)
      : text.slice(0, first) + newString + text.slice(first + oldString.length);
    writeFileSync(abs, next, 'utf8');
    return {
      ok: true,
      content: `updated ${toWorkspaceRelative(ctx.workspaceRoot, abs)} (${replaceAll ? count : 1} replacement)`,
    };
  },
};
