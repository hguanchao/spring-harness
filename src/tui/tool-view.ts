/**
 * 工具调用的呈现投影：一行「摘要」+ 可读的「正文」。
 *
 * 这一层知道每个工具的入参与结果文本长什么样，但不依赖工具实现，也不做语义推断——
 * 全部从 args 与结果文本推导，所以新增工具会自动退化成通用的 `k=v` 摘要。
 *
 * 设计取舍：
 * - 摘要行回答「做了什么、影响多大」，必须一眼可读（路径、行号区间、命中数、增删行数、退出码）；
 * - 正文行保留原文，只按工具类型补结构（read_file 的行号槽、grep 的 path:line: 前缀、
 *   list_dir 的类型列、shell 的 exit/stdout 段头）。旧实现把整块正文压成 dim，
 *   恰好把「你真正要读的内容」压暗了，这里反过来：正文用默认前景，只有元信息才 dim。
 * - 所有符号都是 ASCII：`->`、`...`。东亚歧义宽度字符（·、↑、…）在部分终端按 2 列渲染，
 *   会让活动区行宽计算失真，UI 骨架一律不用。
 */

import type { Styler } from './ansi.js';
import { wrap } from './ansi.js';

export interface ToolCallView {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** 结果正文；`tool_start` 阶段为空串，此时摘要不输出统计量。 */
  detail: string;
  ok?: boolean;
  durationMs?: number;
  /** 二级展开：这一条的结果正文是否可见（块自身展开后才看得到摘要行）。 */
  expanded?: boolean;
}

export interface DetailOptions {
  width: number;
  indent: number;
  maxLines: number;
  styler: Styler;
}

/** 工具名与成败对应的着色：成功绿、失败红、结果未知（历史回放）用默认色。 */
export function toolTone(ok: boolean | undefined, styler: Styler): (text: string) => string {
  if (ok === undefined) return (text) => text;
  return ok ? (text) => styler.green(text) : (text) => styler.red(text);
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m${Math.round((ms % 60_000) / 1000)}s`;
}

/** 摘要行（纯文本，不含着色）：由调用方决定如何着色。 */
export function summarizeToolCall(call: ToolCallView): string {
  const { name, args, detail } = call;
  const hasDetail = detail !== '';
  switch (name) {
    case 'read_file': {
      const path = str(args, 'path') ?? '?';
      const range = hasDetail ? readFileRange(detail) : undefined;
      if (!range) return path;
      return `${path}:${range.first}-${range.last} (${range.count} ${range.count === 1 ? 'line' : 'lines'})`;
    }
    case 'write': {
      const path = str(args, 'path') ?? '?';
      const body = typeof args.content === 'string' ? args.content : '';
      return hasDetail ? `${path} +${lineCount(body)}` : path;
    }
    case 'search_replace': {
      const path = str(args, 'path') ?? '?';
      if (!hasDetail) return path;
      const removed = lineCount(str(args, 'old_string') ?? '');
      const added = lineCount(str(args, 'new_string') ?? '');
      const times = /(\d+)\s+replacement/.exec(detail)?.[1];
      return `${path} -${removed}/+${added}${times ? ` x${times}` : ''}`;
    }
    case 'grep': {
      const pattern = str(args, 'pattern') ?? '';
      const where = str(args, 'path');
      if (!hasDetail) return `"${pattern}"${where ? ` ${where}` : ''}`;
      const hits = detail === 'no matches' ? 0 : detail.split('\n').filter((line) => line.trim() !== '').length;
      return `"${pattern}"${where ? ` ${where}` : ''} -> ${hits} matches`;
    }
    case 'list_dir': {
      const path = str(args, 'path') ?? '?';
      if (!hasDetail) return path;
      return `${path} (${countListEntries(detail)} entries)`;
    }
    case 'shell': {
      const command = (str(args, 'command') ?? '').replace(/\s+/g, ' ').slice(0, 72);
      const exit = hasDetail ? /^exit (\S+)/m.exec(detail)?.[1] : undefined;
      return `$ ${command}${exit ? ` -> exit ${exit}` : ''}`;
    }
    default: {
      const rest = summarizeArgs(args);
      return rest === '' ? name : `${name} ${rest}`;
    }
  }
}

/** 未知工具的通用摘要：`k=v` 顺序拼接，单值截断，避免整段 JSON 刷屏。 */
export function summarizeArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text === undefined) continue;
    parts.push(`${key}=${text.replace(/\s+/g, ' ').slice(0, 80)}`);
  }
  return parts.join(' ');
}

/**
 * 一个工具在汇总标签里占的「桶」。
 *
 * key 是去重用的：grok 数的是「读了几个文件」而不是「调了几次 read_file」——
 * 同一个文件读三遍显示 `Read 1 file` 才是读者关心的量。文件/命令/模式这类参数就是天然的身份。
 */
interface VerbBucket {
  /** 完成时态，用于已经跑完的一步。 */
  verb: string;
  /** 进行时态，用于还在跑的一步（grok 的 running 标签用现在分词）。 */
  running: string;
  noun: string;
  key: string;
}

function argKey(call: ToolCallView, field: string): string {
  const value = call.args[field];
  return typeof value === 'string' && value !== '' ? value : call.id;
}

function verbOf(call: ToolCallView): Omit<VerbBucket, 'key'> & { key: string } {
  switch (call.name) {
    case 'read_file':
      return { verb: 'Read', running: 'Reading', noun: 'file', key: argKey(call, 'path') };
    case 'write':
      return { verb: 'Wrote', running: 'Writing', noun: 'file', key: argKey(call, 'path') };
    case 'search_replace':
      return { verb: 'Edited', running: 'Editing', noun: 'file', key: argKey(call, 'path') };
    case 'grep':
      return { verb: 'Searched', running: 'Searching', noun: 'pattern', key: argKey(call, 'pattern') };
    case 'list_dir':
      return { verb: 'Listed', running: 'Listing', noun: 'dir', key: argKey(call, 'path') };
    case 'shell':
      return { verb: 'Ran', running: 'Running', noun: 'command', key: argKey(call, 'command') };
    case 'web_fetch':
      return { verb: 'Fetched', running: 'Fetching', noun: 'URL', key: argKey(call, 'url') };
    case 'subagent':
      return { verb: 'Ran', running: 'Running', noun: 'subagent', key: argKey(call, 'prompt') };
    case 'skill':
      return { verb: 'Loaded', running: 'Loading', noun: 'skill', key: argKey(call, 'name') };
    case 'mcp':
      return { verb: 'Called', running: 'Calling', noun: 'MCP tool', key: `${argKey(call, 'server')}/${argKey(call, 'tool')}` };
    case 'todo':
      return { verb: 'Updated', running: 'Updating', noun: 'to-do list', key: 'todo' };
    case 'jobs':
      return { verb: 'Checked', running: 'Checking', noun: 'job', key: argKey(call, 'id') };
    case 'ask_user':
      return { verb: 'Asked', running: 'Asking', noun: 'question', key: call.id };
    case 'exit_plan_mode':
      return { verb: 'Proposed', running: 'Proposing', noun: 'plan', key: call.id };
    default:
      return { verb: 'Called', running: 'Calling', noun: 'tool', key: call.id };
  }
}

const PLURAL_OVERRIDES: Record<string, string> = {
  'MCP tool': 'MCP tools',
};

function pluralize(noun: string, count: number): string {
  if (count === 1) return noun;
  return PLURAL_OVERRIDES[noun] ?? `${noun}s`;
}

/**
 * 工具调用 → 一行聚合标签（照 grok-build 的写法）。
 *
 * `Read 2 files, Searched 1 pattern, Ran 3 commands`：按动词分桶、桶内去重、用 `, ` 连接。
 * 有任何一个还在跑时全部用进行时（`Reading 2 files`），与之一致。
 * 思考链刻意不参与这个标签——它按 grok 的做法单列一行，不进工具统计。
 */
export function summarizeToolRun(items: readonly ToolCallView[]): { label: string; running: boolean } {
  const order: string[] = [];
  const buckets = new Map<string, { verb: string; running: string; noun: string; keys: Set<string> }>();
  let running = false;
  for (const item of items) {
    const { verb, running: verbRunning, noun, key } = verbOf(item);
    if (item.ok === undefined) running = true;
    const id = `${verb} ${noun}`;
    let bucket = buckets.get(id);
    if (!bucket) {
      bucket = { verb, running: verbRunning, noun, keys: new Set() };
      buckets.set(id, bucket);
      order.push(id);
    }
    bucket.keys.add(key);
  }
  const label = order
    .map((id) => buckets.get(id))
    .filter((bucket): bucket is NonNullable<typeof bucket> => bucket !== undefined)
    .map((bucket) => `${running ? bucket.running : bucket.verb} ${bucket.keys.size} ${pluralize(bucket.noun, bucket.keys.size)}`)
    .join(', ');
  return { label, running };
}

/**
 * 结果正文行（已缩进，未补齐到整宽）。
 * 每行都保证 displayWidth <= width 由调用方折行负责，这里只做「已量宽的文本 + 着色」。
 */
export function renderToolDetail(call: ToolCallView, options: DetailOptions): string[] {
  const { width, indent, maxLines, styler } = options;
  if (call.detail.trim() === '') return [];
  const pad0 = ' '.repeat(indent);
  const available = Math.max(8, width - indent);
  const wrapped = dropRedundantHeader(call, wrap(call.detail, available));
  const shown = wrapped.slice(0, maxLines);
  const out = shown.map((line) => pad0 + styleDetailLine(call, line, styler));
  const hidden = wrapped.length - shown.length;
  if (hidden > 0) out.push(styler.dim(`${pad0}... ${hidden} more lines`));
  return out;
}

/**
 * 丢掉与摘要重复的首行。read_file / list_dir 的结果第一行都是相对路径，而摘要里
 * 已经有路径了；多工具块的预览只有 2 行预算，这种重复等于白白吃掉一半。
 */
function dropRedundantHeader(call: ToolCallView, lines: string[]): string[] {
  if (lines.length <= 1) return lines;
  if (call.name === 'list_dir') return lines.slice(1);
  if (call.name === 'read_file' && !/^\s*\d+\|/.test(lines[0])) return lines.slice(1);
  return lines;
}

/** 按工具类型给正文补结构：只 dim 元信息，内容保持默认前景。 */
function styleDetailLine(call: ToolCallView, line: string, styler: Styler): string {
  switch (call.name) {
    case 'read_file': {
      const numbered = /^(\s*\d+\|)(.*)$/.exec(line);
      if (numbered) return styler.dim(numbered[1]) + numbered[2];
      // 首行是相对路径，尾行是截断提示：都属于元信息。
      return styler.dim(line);
    }
    case 'grep': {
      const hit = /^([^:]+):(\d+):(.*)$/.exec(line);
      if (!hit) return line;
      return styler.dim(hit[1]) + styler.cyan(`:${hit[2]}:`) + highlightLiteral(hit[3], call.args, styler);
    }
    case 'list_dir': {
      const entry = /^(dir|file)\s+(\S.*)$/.exec(line);
      if (entry) return styler.dim(`${entry[1]} `) + entry[2];
      return styler.dim(line);
    }
    case 'shell': {
      if (/^exit \S+$/.test(line) || /^(stdout|stderr):$/.test(line)) return styler.dim(line);
      return line;
    }
    default:
      return line;
  }
}

/** 高亮结果里出现的搜索串。用 indexOf 字面匹配：模式串可能是正则，不做二次编译。 */
function highlightLiteral(text: string, args: Record<string, unknown>, styler: Styler): string {
  const pattern = str(args, 'pattern') ?? '';
  if (pattern === '') return text;
  const at = text.indexOf(pattern);
  if (at < 0) return text;
  return text.slice(0, at) + styler.highlight(pattern) + text.slice(at + pattern.length);
}

function readFileRange(detail: string): { first: number; last: number; count: number } | undefined {
  let first: number | undefined;
  let last = 0;
  let count = 0;
  for (const line of detail.split('\n')) {
    const match = /^\s*(\d+)\|/.exec(line);
    if (!match) continue;
    const value = Number(match[1]);
    if (first === undefined) first = value;
    last = value;
    count++;
  }
  return first === undefined ? undefined : { first, last, count };
}

/** 目录列表的结果首行是相对路径，其余每行一个条目。 */
function countListEntries(detail: string): number {
  const lines = detail.split('\n').slice(1).filter((line) => line.trim() !== '');
  if (lines.length === 1 && lines[0] === '(empty)') return 0;
  return lines.length;
}

function lineCount(text: string): number {
  if (text === '') return 0;
  return text.split('\n').length;
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}
