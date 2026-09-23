/**
 * MCP 配置的写回。
 *
 * 两件事：
 *   1. `[mcp_servers.<name>]` 的新增 / 更新 / 删除（与 Codex 同一套表头）；
 *   2. `[mcp]` 段的 `disabled_servers` / `enabled_servers` 本地启停偏好。
 *
 * 为什么不用「解析成对象 → 序列化整份重写」：与 `config/save.ts` 同一理由——这是用户手改
 * 的文件，带注释、带键顺序、带自己排的对齐。整体重写会把它变成生成物。这里只动被改的那几行。
 *
 * 比 `save.ts` 多出来的难度在于**表块**：数组表的边界要靠逐行扫描确定，而多行数组
 * （`args = [\n "-a",\n]`）里以 `[` 开头的行不是表头。所以扫描时必须跟踪括号深度与
 * 三引号字符串——否则一次「删除某个 server」就可能把后面半份配置当成它的一部分删掉。
 *
 * 外部来源的文件（Claude / Codex / `.mcp.json`）**绝不写入**，启停改走本地偏好。
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { bracketDelta, codeOf, scanHeaders, trailingComment, type TomlHeader } from './toml-lines.js';

export interface SphMcpEntry {
  name: string;
  command: string;
  args?: string[];
}

/** 一个单行字符串值的渲染，供写回用。 */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function tomlArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

/**
 * 把一行命令拆成 `command` + `args`。
 *
 * 支持双引号包住含空格的段（Windows 路径很常见），引号内可用 `\"` 转义。刻意**不做**
 * 完整的 shell 解析：这里只是把用户敲的一行落进配置文件，通配符、管道、变量展开都不该
 * 有语义——给了语义反而会让「配置里写了 `~` 却没展开」这类问题变得难以解释。
 *
 * 引号未闭合时返回 undefined 让调用方报错：那种输入下任何切分都是猜的。
 */
export function splitCommandLine(input: string): { command: string; args: string[] } | undefined {
  const parts: string[] = [];
  let current = '';
  let started = false;
  let inQuote = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (inQuote) {
      if (ch === '\\' && input[i + 1] === '"') {
        current += '"';
        i += 1;
        continue;
      }
      if (ch === '"') {
        inQuote = false;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"') {
      inQuote = true;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        parts.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (inQuote) return undefined;
  if (started) parts.push(current);
  const command = parts[0];
  // `""` 会切出一个空命令：它无法被 spawn，当成「用户还没填完」处理比写进配置好。
  if (command === undefined || command === '') return undefined;
  return { command, args: parts.slice(1) };
}

interface Doc {
  original: string;
  eol: string;
  endsWithNewline: boolean;
  lines: string[];
}

function open(path: string): Doc {
  const original = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const endsWithNewline = original.endsWith('\n');
  const lines = original === '' ? [] : original.split(/\r?\n/);
  // split 会在结尾换行后多出一个空元素；插入前必须去掉，否则新增内容顶上会多一个空行。
  if (endsWithNewline) lines.pop();
  return { original, eol, endsWithNewline, lines };
}

function commit(path: string, doc: Doc, lines: string[]): void {
  const text = `${lines.join(doc.eol)}${doc.eol}`;
  // 内容没变就不碰文件：避免无谓地改动 mtime（编辑器和同步工具会因此误报）。
  if (text === doc.original) return;
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

/** 某个表头之后的块区间：`[start, end)`，`start` 是表头行本身。 */
interface Block {
  headerLine: number;
  start: number;
  end: number;
  name?: string;
}

/** `[mcp_servers.context7]` 的名字。子表（`mcp_servers.context7.headers`）不是一条 server。 */
function serverNameOf(header: TomlHeader): string | undefined {
  if (header.array || !header.name.startsWith('mcp_servers.')) return undefined;
  let rest = header.name.slice('mcp_servers.'.length).trim();
  if (rest.startsWith('"') && rest.endsWith('"') && rest.length >= 2) {
    rest = rest.slice(1, -1).replace(/\\"/g, '"');
  }
  if (rest === '' || rest.includes('.')) return undefined;
  return rest;
}

function blockEnd(lines: readonly string[], headers: readonly (TomlHeader | undefined)[], headerLine: number): number {
  for (let j = headerLine + 1; j < lines.length; j++) {
    if (headers[j] !== undefined) return j;
  }
  return lines.length;
}

/** 找出 `[mcp_servers.<name>]` 的全部块。名字在表头上。 */
function mcpServerBlocks(lines: readonly string[], headers: readonly (TomlHeader | undefined)[]): Block[] {
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const header = headers[i];
    if (header === undefined) continue;
    const name = serverNameOf(header);
    if (name === undefined) continue;
    blocks.push({ headerLine: i, start: i, end: blockEnd(lines, headers, i), name });
  }
  return blocks;
}

function tomlServerHeader(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? `[mcp_servers.${name}]` : `[mcp_servers.${tomlString(name)}]`;
}

function parseTomlString(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return undefined;
}

/** 纯读取：列出 `[mcp_servers.<name>]`。解析失败时返回空表，交给调用方决定怎么报。 */
export function listSphMcpServers(path: string): SphMcpEntry[] {
  const doc = open(path);
  const headers = scanHeaders(doc.lines);
  return mcpServerBlocks(doc.lines, headers).map((block) => ({
    name: block.name ?? '',
    command: readKey(doc.lines, block.start + 1, block.end, 'command') ?? '',
    args: readArray(doc.lines, block.start + 1, block.end, 'args'),
  }));
}

function readKey(lines: readonly string[], from: number, to: number, key: string): string | undefined {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`);
  for (let i = from; i < to; i++) {
    const match = re.exec(codeOf(lines[i]!));
    if (match !== null) return parseTomlString(match[1]!.trim());
  }
  return undefined;
}

function readArray(lines: readonly string[], from: number, to: number, key: string): string[] | undefined {
  const re = new RegExp(`^\\s*${key}\\s*=`);
  for (let i = from; i < to; i++) {
    if (!re.test(codeOf(lines[i]!))) continue;
    // 值可能跨行：把括号补全后再按字符串切。
    const collected: string[] = [];
    let depth = 0;
    for (let j = i; j < to; j++) {
      const code = codeOf(lines[j]!);
      collected.push(code);
      depth += bracketDelta(code);
      if (depth <= 0) break;
    }
    const body = collected.join('\n');
    const items = body.slice(body.indexOf('[') + 1, body.lastIndexOf(']'));
    const out: string[] = [];
    for (const raw of items.split(',')) {
      const value = parseTomlString(raw.trim());
      if (value !== undefined) out.push(value);
    }
    return out;
  }
  return undefined;
}

/**
 * 新增或更新一条 `[mcp_servers.<name>]`。
 *
 * 已存在时只替换 `command` / `args`，块内的 `type`、注释和其它键原样保留。
 * 不存在时新建一块，带上 `type = "stdio"`，插在最后一个 server 块之后。
 */
export function upsertSphMcpServer(path: string, entry: SphMcpEntry): { added: boolean } {
  const doc = open(path);
  const headers = scanHeaders(doc.lines);
  const blocks = mcpServerBlocks(doc.lines, headers);
  const block = blocks.find((item) => item.name === entry.name);

  if (block === undefined) {
    const last = blocks.at(-1);
    const at = last === undefined ? trailingInsertAt(doc.lines) : last.end;
    const fresh = [tomlServerHeader(entry.name), 'type = "stdio"', `command = ${tomlString(entry.command)}`];
    if (entry.args !== undefined) fresh.push(`args = ${tomlArray(entry.args)}`);
    const lines = [...doc.lines.slice(0, at), '', ...fresh, ...doc.lines.slice(at)];
    commit(path, doc, lines);
    return { added: true };
  }

  const lines = [...doc.lines];
  const setKey = (key: string, rendered: string): void => {
    const re = new RegExp(`^(\\s*${key}\\s*=\\s*)(.*)$`);
    for (let i = block.start + 1; i < block.end; i++) {
      const match = re.exec(lines[i]!);
      if (match === null) continue;
      // 值可能跨行（多行数组）：连同续行一起吃掉，只留渲染后的单行。
      // 不这么做会留下 `  "-y",` / `]` 这样的孤儿行，直接把文件变成坏 TOML。
      let end = i + 1;
      let depth = bracketDelta(codeOf(lines[i]!));
      while (depth > 0 && end < block.end) {
        depth += bracketDelta(codeOf(lines[end]!));
        end += 1;
      }
      lines.splice(i, end - i, `${match[1]}${rendered}${trailingComment(match[2]!)}`);
      block.end -= end - i - 1;
      return;
    }
    // 键不在块里：插到块尾之前。
    lines.splice(block.end, 0, `${key} = ${rendered}`);
    block.end += 1;
  };
  setKey('command', tomlString(entry.command));
  if (entry.args !== undefined) setKey('args', tomlArray(entry.args));
  commit(path, doc, lines);
  return { added: false };
}

/** 删掉整个表块。返回是否找到。 */
export function removeSphMcpServer(path: string, name: string): boolean {
  const doc = open(path);
  const headers = scanHeaders(doc.lines);
  const block = mcpServerBlocks(doc.lines, headers).find((item) => item.name === name);
  if (block === undefined) return false;

  let end = block.end;
  // 顺带吃掉块后紧跟的空行，避免删完留下双空行。
  while (end < doc.lines.length && doc.lines[end]!.trim() === '') end += 1;
  let start = block.start;
  while (start > 0 && doc.lines[start - 1]!.trim() === '') start -= 1;
  const lines = [...doc.lines.slice(0, start), ...doc.lines.slice(end)];
  commit(path, doc, lines);
  return true;
}

/** 文件末尾的插入点：跳过尾部空行，免得在文件最后堆出一串空行。 */
function trailingInsertAt(lines: readonly string[]): number {
  let at = lines.length;
  while (at > 0 && lines[at - 1]!.trim() === '') at -= 1;
  return at;
}

/**
 * 启停偏好：写进 sph 用户级配置的 `[mcp]` 段。
 *
 * 两个列表各司其职，让它们只剩有意义的条目：
 *   - `disabled_servers`：本地关掉某个来源本来启用的 server；
 *   - `enabled_servers`：本地打开某个来源**自己声明了 `disabled = true`** 的 server。
 *
 * 所以调用方要同时给出「期望状态」与「来源声明状态」——只写一个列表会导致另一个列表
 * 里留下过期的强制项，日后来源改了自己的默认值就会被那条陈旧偏好悄悄盖住。
 */
export function setSphMcpPreference(
  path: string,
  name: string,
  options: { enabled: boolean; sourceEnabled: boolean },
): void {
  const doc = open(path);
  const headers = scanHeaders(doc.lines);
  const table = tableRange(doc.lines, headers, 'mcp');

  const disabled = readArrayIn(doc.lines, table, 'disabled_servers');
  const enabled = readArrayIn(doc.lines, table, 'enabled_servers');
  const nextDisabled = new Set(disabled);
  const nextEnabled = new Set(enabled);

  if (options.enabled) {
    nextDisabled.delete(name);
    if (options.sourceEnabled) nextEnabled.delete(name);
    else nextEnabled.add(name);
  } else {
    nextEnabled.delete(name);
    nextDisabled.add(name);
  }

  writeArrayIn(path, doc, 'disabled_servers', [...nextDisabled], table);
  // 第一次写入可能插入了新表或新键，行号随之变化：重新读取一次再定位，避免写到过期位置。
  const refreshedDoc = open(path);
  const refreshed = tableRange(refreshedDoc.lines, scanHeaders(refreshedDoc.lines), 'mcp');
  writeArrayIn(path, refreshedDoc, 'enabled_servers', [...nextEnabled], refreshed);
}

/** lazy 偏好：`[mcp] lazy_servers` 只含**当前标记为懒**的 server，开/关即增/删一条。 */
export function setSphMcpLazy(path: string, name: string, lazy: boolean): void {
  const doc = open(path);
  const table = tableRange(doc.lines, scanHeaders(doc.lines), 'mcp');
  const next = new Set(readArrayIn(doc.lines, table, 'lazy_servers'));
  if (lazy) next.add(name);
  else next.delete(name);
  writeArrayIn(path, doc, 'lazy_servers', [...next], table);
}

/** `[mcp]` 表的行区间；不存在时给一个「从文件末尾追加」的空区间。 */
function tableRange(
  lines: readonly string[],
  headers: readonly (TomlHeader | undefined)[],
  name: string,
): { start: number; end: number } {
  for (let i = 0; i < lines.length; i++) {
    const header = headers[i];
    if (header === undefined || header.array || header.name !== name) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (headers[j] !== undefined) {
        end = j;
        break;
      }
    }
    return { start: i, end };
  }
  return { start: -1, end: -1 };
}

function readArrayIn(lines: readonly string[], table: { start: number; end: number }, key: string): string[] {
  if (table.start < 0) return [];
  return readArray(lines, table.start + 1, table.end, key) ?? [];
}

function writeArrayIn(
  path: string,
  doc: Doc,
  key: string,
  values: readonly string[],
  table: { start: number; end: number },
): void {
  const lines = [...doc.lines];
  const rendered = tomlArray(values);
  if (table.start >= 0) {
    const re = new RegExp(`^(\\s*${key}\\s*=\\s*)(.*)$`);
    for (let i = table.start + 1; i < table.end; i++) {
      if (!re.test(lines[i]!)) continue;
      // 值可能跨行：连同后续行一起吃掉，只留下渲染后的单行。
      let end = i + 1;
      let depth = bracketDelta(codeOf(lines[i]!));
      while (depth > 0 && end < table.end) {
        depth += bracketDelta(codeOf(lines[end]!));
        end += 1;
      }
      lines.splice(i, end - i, `${key} = ${rendered}`);
      commit(path, doc, lines);
      return;
    }
    lines.splice(table.end, 0, `${key} = ${rendered}`);
    commit(path, doc, lines);
    return;
  }
  const at = trailingInsertAt(lines);
  lines.splice(at, 0, '', '[mcp]', `${key} = ${rendered}`);
  commit(path, doc, lines);
}
