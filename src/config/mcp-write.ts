/**
 * MCP 配置的写回。
 *
 * 两件事：
 *   1. `[mcp_servers.<name>]` 的新增 / 更新 / 删除；
 *   2. 同一个表里的 `disabled` 启停开关。
 *
 * 为什么不用「解析成对象 → 序列化整份重写」：与 `config/save.ts` 同一理由——这是用户手改
 * 的文件，带注释、带键顺序、带自己排的对齐。整体重写会把它变成生成物。这里只动被改的那几行。
 *
 * 比 `save.ts` 多出来的难度在于**表块**：数组表的边界要靠逐行扫描确定，而多行数组
 * （`args = [\n "-a",\n]`）里以 `[` 开头的行不是表头。所以扫描时必须跟踪括号深度与
 * 三引号字符串——否则一次「删除某个 server」就可能把后面半份配置当成它的一部分删掉。
 *
 * 外部来源的文件**绝不写入**：关掉它们声明的 server 靠写一条同名的禁用标记，见
 * {@link setSphMcpDisabled}。
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
 * 启停一个 server：改写 `[mcp_servers.<name>]` 里的 `disabled` 键（缺省 false，即启用）。
 *
 * 关掉外部来源声明的 server 也走这里：sph 的配置优先级最高，写一条同名的
 * `[mcp_servers.<name>] disabled = true`（可以没有 command / url）就整条盖住低优先级的定义，
 * 于是不必去动别人的文件。
 *
 * 重新启用时把键删掉而不是写 `false`：缺省本来就是启用，多一个 `disabled = false` 只是噪音。
 * 若删完这块里再也没有 command / url（说明它当初只是一条禁用标记），连块一起删——留一个
 * 没有定义的孤儿表，日后只会变成一条「needs a command or a url」的警告。
 *
 * 外部来源自己声明了 `disabled`、而 sph 配置里还没有同名块时，启用要写出
 * `disabled = false`：缺省启用盖不住别人文件里明确写下的禁用。
 */
export function setSphMcpDisabled(path: string, name: string, disabled: boolean): void {
  const doc = open(path);
  const block = mcpServerBlocks(doc.lines, scanHeaders(doc.lines)).find((item) => item.name === name);

  if (block === undefined) {
    if (!disabled) {
      const at = trailingInsertAt(doc.lines);
      const lines = [...doc.lines.slice(0, at), '', tomlServerHeader(name), 'disabled = false', ...doc.lines.slice(at)];
      commit(path, doc, lines);
      return;
    }
    const at = trailingInsertAt(doc.lines);
    const lines = [...doc.lines.slice(0, at), '', tomlServerHeader(name), 'disabled = true', ...doc.lines.slice(at)];
    commit(path, doc, lines);
    return;
  }

  const keyLine = keyLineIn(doc.lines, block, 'disabled');
  if (disabled) {
    const lines = [...doc.lines];
    if (keyLine === -1) lines.splice(block.end, 0, 'disabled = true');
    else {
      // 只换值，缩进与行尾注释留着（用户可能写了 `disabled = false   # 先观望着`）。
      const match = /^(\s*disabled\s*=\s*)\S+(.*)$/.exec(lines[keyLine]!);
      lines[keyLine] = `${match?.[1] ?? 'disabled = '}true${match?.[2] ?? ''}`;
    }
    commit(path, doc, lines);
    return;
  }

  // 要启用却没有这个键：本来就是启用态。不碰文件，免得白改一次 mtime。
  if (keyLine === -1) return;
  const lines = [...doc.lines];
  lines.splice(keyLine, 1);
  const end = block.end - 1;
  const hasDefinition = lines
    .slice(block.start + 1, end)
    .some((line) => /^\s*(command|url)\s*=/.test(codeOf(line)));
  if (hasDefinition) {
    commit(path, doc, lines);
    return;
  }
  let to = end;
  while (to < lines.length && lines[to]!.trim() === '') to += 1;
  let from = block.start;
  while (from > 0 && lines[from - 1]!.trim() === '') from -= 1;
  commit(path, doc, [...lines.slice(0, from), ...lines.slice(to)]);
}

/** 块内某个键的行号；没有返回 -1。 */
function keyLineIn(lines: readonly string[], block: Block, key: string): number {
  const re = new RegExp(`^\\s*${key}\\s*=`);
  for (let i = block.start + 1; i < block.end; i++) {
    if (re.test(codeOf(lines[i]!))) return i;
  }
  return -1;
}
