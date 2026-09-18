/**
 * 把 TUI 里的选择写回 config.toml。
 *
 * 为什么不做「解析成对象 → 整体序列化重写」：config.toml 是用户手改的文件，带着成片注释
 * （当前那份 16 行里有 11 行注释）。整体重写会把注释、键顺序、未知键、对齐全部抹掉，
 * 等于把人家的配置文件变成生成物。这里只做外科手术式替换，三种情形分别处理：
 *   1. 命中未注释的同名键 → 只换值，行尾注释与前后空白原样保留；
 *   2. 只命中被注释掉的模板行（如 `# reasoning_effort = "medium"   # off | low | ...`）
 *      → 就地取消注释并换值，模板里的说明自动变成行尾注释；
 *   3. 都没有 → 追加到**第一个表头之前**。
 *
 * 第 3 条的落点是有讲究的：TOML 里表头之后的键属于该表，追加到文件末尾会把
 * `approval = "yolo"` 写成 `[mcp]` 的 `approval`——解析成功、值也在文件里，但顶层读不到，
 * 表现为「设置明明写进去了却不生效」。同理，查找已有键时也只认表头之前的部分，
 * 否则表体里一个同名键会把值写错地方。
 *
 * 值支持标量、非负整数与字符串数组：`trusted` 这类清单会被整行替换，用户手工折成
 * 多行时按括号配平吃掉整个值（见 valueSpan），否则只换首行会在文件里留下孤儿行。
 *
 * 表体里的键（`[grants]` 的每个作用域）走 updateConfigTableEntry：它们的键是**用户数据**
 * 而不是固定字段名，且会随批准次数增长，不能靠「顶层标量」那条路径。
 *
 * 写入用「临时文件 + rename」：rename 在同一文件系统上是原子的，写到一半失败也不会
 * 把用户的配置截断成半截。
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { escapeRegExp } from '../util.js';
import { bracketDelta, codeOf, firstTableHeaderLine, scanHeaders, trailingComment } from './toml-lines.js';

export type ConfigValue = string | number | readonly string[];

export interface SaveResult {
  path: string;
  /** 本次确保生效的键（值本来就相同也会列出——调用方据此说「已写入」）。 */
  keys: string[];
  /** 其中原本文件中不存在、被追加的键。 */
  added: string[];
}

export function updateConfigFile(path: string, patch: Readonly<Record<string, ConfigValue>>): SaveResult {
  // 先挡一道：路径为空/未定义时 existsSync 返回 false（不抛错），会一路走到
  // 「在 cwd 写出 undefined.tmp-<pid> 然后 rename 失败」，留下谁也不知道来历的垃圾文件。
  if (typeof path !== 'string' || path === '') {
    throw new Error('updateConfigFile: config path is empty');
  }
  const original = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const endsWithNewline = original.endsWith('\n');
  const lines = original === '' ? [] : original.split(/\r?\n/);
  // split 会在结尾换行后多出一个空元素；append 前必须去掉，否则新增键顶上会多一个空行。
  if (endsWithNewline) lines.pop();

  // 顶层标量只可能出现在第一个表头之前，查找范围就限定在这里。
  const header = firstTableHeaderLine(lines);
  const scalarEnd = header < 0 ? lines.length : header;

  const keys: string[] = [];
  const added: string[] = [];
  const appended: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const rendered = renderValue(value);
    // 三个匹配用的正则只与 key 有关,预编译一次,避免在 findIndex 的每行回调里反复 new RegExp。
    const keyRe = escapeRegExp(key);
    const activeRe = new RegExp(`^\\s*${keyRe}\\s*=`);
    const commentedRe = new RegExp(`^\\s*#\\s*${keyRe}\\s*=`);
    const replaceRe = new RegExp(`^(\\s*${keyRe}\\s*=\\s*)(.*)$`);
    const active = lines.findIndex((line, index) => index < scalarEnd && activeRe.test(line));
    if (active >= 0) {
      const match = replaceRe.exec(lines[active]!);
      const span = valueSpan(lines, active, match?.[1]?.length ?? 0);
      if (span > 1) {
        // 多行值整段换成一行：只换首行会在文件里留下 `]` 之类的孤儿行，把配置写坏。
        lines.splice(active, span, `${match?.[1] ?? ''}${rendered}${trailingComment(lines[active + span - 1]!)}`);
      } else {
        lines[active] = replaceValue(lines[active]!, replaceRe, rendered);
      }
      keys.push(key);
      continue;
    }
    const commented = lines.findIndex((line, index) => index < scalarEnd && commentedRe.test(line));
    if (commented >= 0) {
      lines[commented] = activateCommented(lines[commented]!, replaceRe, rendered);
      keys.push(key);
      continue;
    }
    appended.push(`${key} = ${rendered}`);
    keys.push(key);
    added.push(key);
  }

  if (appended.length > 0) {
    // 表头前的空行是留给表头的：回退到那一段空行之前再插，两个区块之间的空行数才不变。
    let at = scalarEnd;
    while (at > 0 && lines[at - 1]!.trim() === '') at -= 1;
    // 回退后若正好停在已有的空行上，它本身就是分隔，再补一个就成了双空行。
    const needsBlank = at < lines.length && lines[at]!.trim() !== '';
    lines.splice(at, 0, ...appended, ...(needsBlank ? [''] : []));
  }

  const text = `${lines.join(eol)}${eol}`;
  // 内容没变就不碰文件：避免无谓地改动 mtime（编辑器和同步工具会因此误报）。
  if (text !== original) writeAtomically(path, text);
  return { path, keys, added };
}

/** 原子写文本：临时文件 + rename，写一半失败不截断原文件。供 registry 的 JSON 写回共用。 */
export function writeAtomically(path: string, text: string): void {
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, text, 'utf8');
  try {
    renameSync(temp, path);
  } catch (error) {
    // rename 失败必须自己清掉临时文件：留在磁盘上就是无主垃圾，还可能被顺手提交。
    try {
      rmSync(temp, { force: true });
    } catch {
      // 清理失败就算了，别把原始错误盖掉
    }
    throw error;
  }
}

/** `model = "x"` / `  model=1` 这类未注释的键行。 */
function replaceValue(line: string, replaceRe: RegExp, rendered: string): string {
  const match = replaceRe.exec(line);
  if (!match) return line;
  return `${match[1]}${rendered}${trailingComment(match[2]!)}`;
}

/** 去掉注释符号后按同一套规则换值,于是模板里的说明自然成了新值的行尾注释。 */
function activateCommented(line: string, replaceRe: RegExp, rendered: string): string {
  const match = /^(\s*)#\s*(.*)$/.exec(line);
  if (!match) return line;
  return replaceValue(`${match[1]}${match[2]}`, replaceRe, rendered);
}

function renderValue(value: ConfigValue): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return renderString(value);
  return `[${value.map((item) => renderString(item)).join(', ')}]`;
}

function renderString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * 值占用的行数（标量恒为 1）。
 *
 * 从值起点数方括号配平：用户把 `trusted` 折成多行是常见写法，只按行替换会把
 * 第一行改成单行数组、后面几行原样留着——文件语法直接坏掉。
 */
function valueSpan(lines: readonly string[], start: number, valueStart: number): number {
  let depth = bracketDelta(codeOf(lines[start]!.slice(valueStart)));
  if (depth <= 0) return 1;
  for (let i = start + 1; i < lines.length; i++) {
    depth += bracketDelta(codeOf(lines[i]!));
    if (depth <= 0) return i - start + 1;
  }
  // 括号没配平（文件本身已坏）：只当一行，至少不去动别人的行。
  return 1;
}

/**
 * 在指定表的表体内写入一行 `key = value`；表不存在则整表追加。
 *
 * 与 updateConfigFile 的分工：那个只写**顶层标量**，而 `[grants]` 的键是用户数据
 * （每个仓库一行）且会随批准次数增长，必须落在表体内。键一律加引号渲染：路径里的
 * 反斜杠和冒号不引号就不是合法 TOML。
 */
export function updateConfigTableEntry(
  path: string,
  table: string,
  key: string,
  value: ConfigValue,
): SaveResult {
  if (typeof path !== 'string' || path === '') {
    throw new Error('updateConfigTableEntry: config path is empty');
  }
  const original = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original === '' ? [] : original.split(/\r?\n/);
  if (original.endsWith('\n')) lines.pop();

  const renderedKey = renderString(key);
  const rendered = renderValue(value);
  let added = false;

  const headers = scanHeaders(lines);
  const headerAt = headers.findIndex((header) => header !== undefined && !header.array && header.name === table);

  if (headerAt < 0) {
    if (lines.length > 0 && lines[lines.length - 1]!.trim() !== '') lines.push('');
    lines.push(`[${table}]`, `${renderedKey} = ${rendered}`);
    added = true;
  } else {
    let bodyEnd = lines.length;
    for (let i = headerAt + 1; i < lines.length; i++) {
      if (headers[i] !== undefined) {
        bodyEnd = i;
        break;
      }
    }
    const found = lines.findIndex((line, index) => index > headerAt && index < bodyEnd && lineKey(line) === key);
    if (found >= 0) {
      const indent = /^\s*/.exec(lines[found]!)?.[0] ?? '';
      const match = /^\s*[^=]+?\s*=\s*/.exec(lines[found]!);
      const span = valueSpan(lines, found, match?.[0]?.length ?? 0);
      const line = `${indent}${renderedKey} = ${rendered}${trailingComment(lines[found + span - 1]!)}`;
      if (span > 1) lines.splice(found, span, line);
      else lines[found] = line;
    } else {
      // 追加到表体末尾，回退掉表体自带的空行，插在它们之前。
      let at = bodyEnd;
      while (at > headerAt + 1 && lines[at - 1]!.trim() === '') at -= 1;
      lines.splice(at, 0, `${renderedKey} = ${rendered}`);
      added = true;
    }
  }

  const text = `${lines.join(eol)}${eol}`;
  if (text !== original) writeAtomically(path, text);
  return { path, keys: [key], added: added ? [key] : [] };
}

/** 行首的键名（去掉引号）；不是 `key = ...` 的行返回 undefined。 */
function lineKey(line: string): string | undefined {
  const match = /^\s*(.+?)\s*=/.exec(codeOf(line));
  if (!match) return undefined;
  const raw = match[1]!.trim();
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  return raw;
}
