/**
 * edit / write 的行对比。只给界面用：参数里已经有替换前后的文本，
 * 不必把 diff 写进模型看到的工具结果，也不必再读一遍磁盘。
 */

/**
 * 输出像不像一份**统一 diff**。
 *
 * 判定只认结构性标记：hunk 头 `@@ -a,b +c,d @@`，或 `diff --git ` 文件头。只有行首 `-` / `+`
 * 的文本（列表、分隔线、聊天里的加号）不算——那是猜内容，一律按普通输出处理。
 */
export function looksLikeUnifiedDiff(text: string): boolean {
  return /^diff --git /m.test(text) || /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(text);
}

/**
 * 统一 diff 的一行 → 它是哪一种行。
 *
 * 前缀是格式的一部分（git 的约定）：`+++` / `---` / `diff --git` 等是文件头（meta），
 * `@@` 是 hunk 头，`+` / `-` 是增删，其余是上下文。取色由界面层按这个分类决定
 * （底色 / 行号色 / 内容色），这一层不认识主题。
 */
export type UnifiedDiffLineKind = 'add' | 'del' | 'ctx' | 'hunk' | 'meta';

export function unifiedDiffLineKind(line: string): UnifiedDiffLineKind {
  if (/^(?:\+\+\+ |--- |diff --git |index |new file mode |deleted file mode |similarity index |rename )/.test(line)) {
    return 'meta';
  }
  if (line.startsWith('@@')) return 'hunk';
  // `\ No newline at end of file` 是标记不是内容。
  if (line.startsWith('\\')) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}

export type DiffKind = 'add' | 'del' | 'ctx';

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

export interface FileChange {
  lines: DiffLine[];
  added: number;
  removed: number;
  replaceAll: boolean;
  /** 目标文件路径：语法高亮靠它的扩展名选语言（见 diff-syntax.ts）。 */
  path?: string;
  /**
   * 行号起点：write 是 1（写的就是整份内容），edit 是**命中行**的行号（工具在结果里报出来）。
   *
   * 缺省 = 不显示行号。replace_all 命中多处时，片段行号对不上文件（第 12 行的第二处可能在
   * 第 80 行），宁可不给也不给个错的。
   */
  lineBase?: number;
}

/** 从 edit 的结果里取命中行（`… (1 replacement at line 12)`）；取不到就没有行号。 */
export function matchLineFromResult(content: string): number | undefined {
  const match = /at line (\d+)/.exec(content);
  return match === null ? undefined : Number.parseInt(match[1]!, 10);
}

/**
 * 给统一 diff 的每行算旧/新行号。
 *
 * hunk 头 `@@ -a,b +c,d @@` 给两侧起点；`-` 只走旧、`+` 只走新、上下文两边都走。
 * 不属于任何一侧的行（`diff --git` / `index` / `---` / `+++` 文件头）返回空对象——
 * 行号栏整格留空，不假装它们在某一行上。
 */
export function diffLineNumbers(lines: readonly string[]): { old?: number; new?: number }[] {
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  return lines.map((line) => {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header !== null) {
      oldLine = Number.parseInt(header[1]!, 10);
      newLine = Number.parseInt(header[2]!, 10);
      inHunk = true;
      return {};
    }
    if (!inHunk) return {};
    // `\ No newline at end of file` 只是标记，不占行号。
    if (line.startsWith('\\')) return {};
    if (line.startsWith('-')) return { old: oldLine++ };
    if (line.startsWith('+')) return { new: newLine++ };
    return { old: oldLine++, new: newLine++ };
  });
}

/** 两边行数的乘积超过这个值就不再做对齐，避免一次大文件写入卡在界面线程上。 */
const ALIGN_CELL_LIMIT = 50_000;

/**
 * 行号栏形态。**默认单列**：删显旧号、加与上下文显新号——只显示「相关的那一侧」，
 * 不占第二列的宽度（grok 与 opencode 的 unified 视图都是这个默认）。双列（旧|新）无歧义，
 * 但每行多占四列，留成可选。
 */
export const DIFF_LINE_NUMBERS: 'single' | 'dual' = 'single';

/** 单列时显示哪个号：删显旧号，加与上下文显新号（相关的那一侧）。 */
export function singleLineNumber(entry: { old?: number; new?: number }): number | undefined {
  return entry.new ?? entry.old;
}

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

/**
 * 成功的 edit / write 才有对比；参数还没到齐时返回 undefined，行上先不画。
 *
 * `matchLine` 由调用方从工具结果里取（{@link matchLineFromResult}）：edit 的片段 diff 需要它
 * 才能把行号标成文件里的真行号。
 */
export function fileChangeFromArgs(
  toolName: string,
  args: Record<string, unknown>,
  matchLine?: number,
): FileChange | undefined {
  if (toolName === 'edit') {
    if (typeof args.old_string !== 'string' || typeof args.new_string !== 'string') return undefined;
    const replaceAll = args.replace_all === true;
    return {
      ...diffLines(args.old_string, args.new_string),
      replaceAll,
      path: typeof args.path === 'string' ? args.path : undefined,
      lineBase: replaceAll ? undefined : matchLine,
    };
  }
  if (toolName === 'write') {
    if (typeof args.content !== 'string') return undefined;
    const body = splitLines(args.content);
    return {
      lines: body.map((text) => ({ kind: 'add', text })),
      added: body.length,
      removed: 0,
      replaceAll: false,
      path: typeof args.path === 'string' ? args.path : undefined,
      // write 写的就是整份内容：行号是文件里真的 1..N。
      lineBase: 1,
    };
  }
  return undefined;
}
