/**
 * edit / write 的行对比。只给界面用：参数里已经有替换前后的文本，
 * 不必把 diff 写进模型看到的工具结果，也不必再读一遍磁盘。
 */

export type DiffKind = 'add' | 'del' | 'ctx';

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

export interface FileChange {
  lines: DiffLine[];
  added: number;
  removed: number;
  /** write 没有旧内容，画出来的全是新增，要标明这不是相对旧文件的差异。 */
  writtenContent: boolean;
  replaceAll: boolean;
}

/** 两边行数的乘积超过这个值就不再做对齐，避免一次大文件写入卡在界面线程上。 */
const ALIGN_CELL_LIMIT = 50_000;

/** 组展开后默认露出的行数；再双击该行放到 EXPANDED。 */
export const DIFF_PREVIEW_LINES = 8;
export const DIFF_EXPANDED_LINES = 80;

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '' && /[\r\n]$/.test(text)) lines.pop();
  return lines;
}

function unaligned(before: string[], after: string[]): DiffLine[] {
  return [
    ...before.map((text) => ({ kind: 'del' as const, text })),
    ...after.map((text) => ({ kind: 'add' as const, text })),
  ];
}

/** 按行对齐。相同行留作上下文，其余标成增删。 */
export function diffLines(before: string, after: string): { lines: DiffLine[]; added: number; removed: number } {
  const a = splitLines(before);
  const b = splitLines(after);
  const lines = a.length * b.length > ALIGN_CELL_LIMIT ? unaligned(a, b) : align(a, b);
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === 'add') added++;
    else if (line.kind === 'del') removed++;
  }
  return { lines, added, removed };
}

function align(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'ctx', text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      lines.push({ kind: 'del', text: a[i]! });
      i++;
    } else {
      lines.push({ kind: 'add', text: b[j]! });
      j++;
    }
  }
  while (i < n) lines.push({ kind: 'del', text: a[i++]! });
  while (j < m) lines.push({ kind: 'add', text: b[j++]! });
  return lines;
}

/** 成功的 edit / write 才有对比；参数还没到齐时返回 undefined，行上先不画。 */
export function fileChangeFromArgs(toolName: string, args: Record<string, unknown>): FileChange | undefined {
  if (toolName === 'edit') {
    if (typeof args.old_string !== 'string' || typeof args.new_string !== 'string') return undefined;
    return {
      ...diffLines(args.old_string, args.new_string),
      writtenContent: false,
      replaceAll: args.replace_all === true,
    };
  }
  if (toolName === 'write') {
    if (typeof args.content !== 'string') return undefined;
    const body = splitLines(args.content);
    return {
      lines: body.map((text) => ({ kind: 'add', text })),
      added: body.length,
      removed: 0,
      writtenContent: true,
      replaceAll: false,
    };
  }
  return undefined;
}
