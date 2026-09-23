import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { assertInsideWorkspace, looksLikeText, TEXT_SNIFF_BYTES, toWorkspaceRelative } from '../../workspace/boundary.js';
import { asOptionalBool, asString, asStringOrEmpty, guardReadOnlyWrite, type ToolContext, type ToolResult, type ToolSpec } from '../../tools/types.js';

/** 磁盘原文的换行；read_file 会把 CRLF 收成 LF 再给模型。 */
function fileNewline(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function applyNewline(s: string, nl: '\r\n' | '\n'): string {
  const lf = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return nl === '\r\n' ? lf.replace(/\n/g, '\r\n') : lf;
}

/** 模型偶发把 read_file 的 `  12|` 前缀抄进 old_string。 */
function stripReadPrefix(s: string): string {
  return s.replace(/^[ \t]*\d+\|/gm, '');
}

function occurrences(text: string, needle: string): { first: number; count: number } {
  const first = text.indexOf(needle);
  if (first < 0) return { first: -1, count: 0 };
  let count = 1;
  for (let at = text.indexOf(needle, first + needle.length); at >= 0; at = text.indexOf(needle, at + needle.length)) {
    count++;
  }
  return { first, count };
}

export const searchReplaceTool: ToolSpec = {
  name: 'edit',
  description: 'Replace an exact old_string in a workspace file — not sed or awk. Read the file first unless you created or edited it in this turn. old_string must match exactly once: when it is ambiguous, add surrounding lines to make it unique, or set replace_all to change every occurrence. The line-number prefix shown by read is not part of the file — match only the content after it.',
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
    const denial = await guardReadOnlyWrite(ctx, rel, 'edit');
    if (denial) return denial;
    const oldString = asString(args, 'old_string');
    const newString = asStringOrEmpty(args, 'new_string');
    const replaceAll = asOptionalBool(args, 'replace_all');
    const abs = assertInsideWorkspace(ctx.workspaceRoot, rel);
    if (!existsSync(abs)) return { ok: false, content: `file not found: ${rel}` };
    const unseen = ctx.observation?.denyIfUnseen(abs);
    if (unseen) return unseen;
    const raw = readFileSync(abs);
    if (!looksLikeText(abs, raw.subarray(0, TEXT_SNIFF_BYTES))) return { ok: false, content: `refused binary file: ${rel}` };
    const text = raw.toString('utf8');
    const nl = fileNewline(text);
    const needles = [applyNewline(oldString, nl)];
    const stripped = stripReadPrefix(oldString);
    if (stripped !== oldString) needles.push(applyNewline(stripped, nl));
    let needle = needles[0]!;
    let hit = occurrences(text, needle);
    if (hit.first < 0 && needles[1]) {
      needle = needles[1];
      hit = occurrences(text, needle);
    }
    if (hit.first < 0) {
      return {
        ok: false,
        content: `old_string not found in ${rel}. Re-read the file and copy the exact text after the "  N|" prefix.`,
      };
    }
    if (hit.count > 1 && !replaceAll) {
      return { ok: false, content: `old_string matched ${hit.count} times; pass replace_all or make it unique` };
    }
    const replacement = applyNewline(newString, nl);
    // 替换串走函数形式：字符串形式会把 new_string 里的 $& / $` / $' / $$ 当成替换模式
    // 展开（如 $& 变成被匹配的原文、$$ 塌成一个 $），把写得没错的内容静默改写。
    const next = replaceAll
      ? text.replaceAll(needle, () => replacement)
      : text.slice(0, hit.first) + replacement + text.slice(hit.first + needle.length);
    writeFileSync(abs, next, 'utf8');
    ctx.observation?.noteWritten(abs);
    return {
      ok: true,
      content: `updated ${toWorkspaceRelative(ctx.workspaceRoot, abs)} (${replaceAll ? hit.count : 1} replacement)`,
    };
  },
};
