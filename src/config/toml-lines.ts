/**
 * TOML 的逐行扫描基元。
 *
 * 存在的理由：`config/save.ts` 与 `config/mcp-write.ts` 都要在**用户手写的**文件上做
 * 外科手术式替换，而两者的难点是同一个——分清「哪一行是表头」。多行数组（`args = [\n "-a",\n]`）
 * 与多行字符串里的 `[` 不是表头，靠正则逐行判断必然出错，出错方式是**删掉/写歪半份配置**。
 * 所以扫描逻辑只留这一份：括号深度与三引号状态都必须跟踪。
 */

/** 表头：`[[mcp_servers]]` → `{ name: 'mcp_servers', array: true }`。 */
export interface TomlHeader {
  name: string;
  array: boolean;
}

/** 去掉行尾注释（跳过引号内的 `#`）后剩下的代码部分。 */
export function codeOf(line: string): string {
  let inQuote = false;
  let quoteChar = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuote) {
      if (ch === '\\' && quoteChar === '"') {
        i++;
        continue;
      }
      if (ch === quoteChar) inQuote = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
      continue;
    }
    if (ch === '#') return line.slice(0, i);
  }
  return line;
}

/** 本行净开出的方括号数；引号内的括号不算。 */
export function bracketDelta(code: string): number {
  let delta = 0;
  let inQuote = false;
  let quoteChar = '';
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;
    if (inQuote) {
      if (ch === '\\' && quoteChar === '"') {
        i++;
        continue;
      }
      if (ch === quoteChar) inQuote = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
      continue;
    }
    if (ch === '[') delta++;
    else if (ch === ']') delta--;
  }
  return delta;
}

export function parseHeader(code: string): TomlHeader | undefined {
  const trimmed = code.trim();
  if (!trimmed.startsWith('[')) return undefined;
  const array = trimmed.startsWith('[[');
  const close = array ? ']]' : ']';
  if (!trimmed.endsWith(close)) return undefined;
  const inner = trimmed.slice(array ? 2 : 1, trimmed.length - close.length).trim();
  if (inner === '') return undefined;
  // 带引号的键（`["mcp_servers"]`）也认，去掉引号。
  const name = /^["'](.*)["']$/.exec(inner)?.[1] ?? inner;
  return { name, array };
}

/**
 * 每行对应的顶层表头（不是表头的行是 `undefined`）。
 *
 * 「不是表头」包含两种容易被漏掉的情况：跨行数组的后续行，以及多行字符串内部的行。
 */
export function scanHeaders(lines: readonly string[]): (TomlHeader | undefined)[] {
  const out: (TomlHeader | undefined)[] = [];
  let depth = 0;
  let multiline: string | undefined;
  for (const line of lines) {
    if (multiline !== undefined) {
      out.push(undefined);
      if (line.includes(multiline)) multiline = undefined;
      continue;
    }
    if (depth > 0) {
      out.push(undefined);
      depth += bracketDelta(codeOf(line));
      continue;
    }
    const code = codeOf(line);
    const header = parseHeader(code);
    if (header !== undefined) {
      out.push(header);
      continue;
    }
    out.push(undefined);
    const open = /("""|''')/.exec(code);
    if (open !== null) {
      // 同一行又闭合了三引号就不算进入多行。
      if (code.indexOf(open[1]!, open.index + 3) === -1) multiline = open[1]!;
      continue;
    }
    depth += bracketDelta(code);
  }
  return out;
}

/**
 * 取出值后面的行尾注释（含前导空白），供替换值时保留。
 *
 * 前导空白必须原样留下：用户可能是在右侧对齐这批注释，压成一个空格就把对齐弄乱了。
 * `codeOf` 已在引号外的 `#` 处切开，所以 `code` 正好覆盖到 `#` 之前。
 */
export function trailingComment(text: string): string {
  const code = codeOf(text);
  if (code === text) return '';
  const gap = /\s*$/.exec(code)?.[0] ?? '';
  return `${gap === '' ? ' ' : gap}${text.slice(code.length)}`;
}

/**
 * 第一个顶层表头的行号；没有表头返回 -1。
 *
 * 追加**顶层标量**时要用它：TOML 里表头之后的键属于该表，直接追加到文件末尾会把
 * `approval = "ask"` 变成 `[mcp]` 的 `approval`——解析成功、值也写进去了，只是永远读不到。
 */
export function firstTableHeaderLine(lines: readonly string[]): number {
  const headers = scanHeaders(lines);
  return headers.findIndex((header) => header !== undefined);
}
