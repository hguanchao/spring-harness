import { appendFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { SessionFactory, SessionMessage, SessionPort, SessionRecord } from './types.js';
import { lineage, loadTip, messagesOnPath, newEntryId } from './tree.js';

export interface SessionMeta {
  id: string;
  workspaceRoot: string;
  createdAt: string;
}

/**
 * 逐行解析 JSONL。
 *
 * 容错取舍：进程被 kill 时最后一行常是半个 JSON 对象，或用外部工具改坏了某一行。
 * 旧实现一处 JSON.parse 抛错就让整个会话不可读（含后续所有历史），因此这里跳过
 * 无法解析/形状不对的行继续读——会话是可追加日志，部分损坏不应该变成全量失败。
 */
export function parseSessionLine(line: string): SessionRecord | undefined {
  if (line.length === 0) return undefined;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (record === null || typeof record !== 'object') return undefined;
  const type = (record as { type?: unknown }).type;
  return type === 'message' || type === 'event' ? (record as SessionRecord) : undefined;
}

function parseRecords(text: string): SessionRecord[] {
  const out: SessionRecord[] = [];
  for (const line of text.split('\n')) {
    const record = parseSessionLine(line);
    if (record) out.push(record);
  }
  return out;
}

export class JsonlSession implements SessionPort {
  readonly dir: string;
  readonly id: string;
  readonly file: string;
  tip: string | undefined;

  constructor(dir: string, id: string) {
    this.dir = dir;
    this.id = id;
    this.file = join(dir, `${id}.jsonl`);
    this.tip = existsSync(this.file) ? loadTip(parseRecords(readFileSync(this.file, 'utf8'))) : undefined;
  }

  append(record: SessionRecord): void {
    const id = record.id ?? newEntryId();
    const parentId = record.parentId !== undefined ? record.parentId : (this.tip ?? null);
    const row: SessionRecord = { ...record, id, parentId };
    appendFileSync(this.file, `${JSON.stringify(row)}\n`, 'utf8');
    if (row.type === 'event' && row.kind === 'branch_tip' && typeof row.data.id === 'string') {
      this.tip = row.data.id;
      return;
    }
    this.tip = id;
  }

  appendMessage(message: Omit<SessionMessage, 'type' | 'ts'>): void {
    this.append({ type: 'message', ts: new Date().toISOString(), ...message });
  }

  /** 对称于 appendMessage：事件落盘的时间戳与形状只在这一处构造。 */
  appendEvent(kind: string, data: Record<string, unknown>): void {
    this.append({ type: 'event', ts: new Date().toISOString(), kind, data });
  }

  setTip(id: string): void {
    this.appendEvent('branch_tip', { id });
  }

  readAll(): SessionRecord[] {
    if (!existsSync(this.file)) return [];
    return parseRecords(readFileSync(this.file, 'utf8'));
  }

  /** 当前分支上的记录（含旧线性前缀）。 */
  readPath(): SessionRecord[] {
    return lineage(this.readAll(), this.tip);
  }

  /** 原始行（不解析）。给只做子串预筛的调用方用，省掉全量 JSON.parse。 */
  readLines(): string[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, 'utf8').split('\n');
  }

  readMessages(): SessionMessage[] {
    return messagesOnPath(this.readAll(), this.tip);
  }
}

function metaPath(dir: string): string {
  return join(dir, 'current.json');
}

function newSessionId(): string {
  return randomUUID().replaceAll('-', '');
}

export function createSession(dir: string, workspaceRoot: string, makeCurrent = true): JsonlSession {
  mkdirSync(dir, { recursive: true });
  const id = newSessionId();
  const meta: SessionMeta = { id, workspaceRoot, createdAt: new Date().toISOString() };
  if (makeCurrent) writeCurrentMeta(dir, meta);
  // 不在这里写 jsonl：打开 TUI / `/new` 但一条消息都没发时，不应留下空话题。
  // 第一条 appendMessage / appendEvent 才会真正建文件。
  return new JsonlSession(dir, id);
}

/**
 * 续用最近一次会话，或新建。
 *
 * 异步是因为「最近一次」必须靠 [`listSessions`] 判定：子代理会话与主会话躺在同一个目录里，
 * 按文件名排序会随机挑中它们（会话 id 是随机 UUID，不是时间戳，排序结果没有时间含义）。
 */
export async function resumeOrCreate(dir: string, workspaceRoot: string, forceNew: boolean): Promise<JsonlSession> {
  mkdirSync(dir, { recursive: true });
  if (!forceNew && existsSync(metaPath(dir))) {
    const meta = JSON.parse(readFileSync(metaPath(dir), 'utf8')) as SessionMeta;
    const file = join(dir, `${meta.id}.jsonl`);
    if (existsSync(file)) return new JsonlSession(dir, meta.id);
  }
  if (!forceNew) {
    // 只续主会话：listSessions 已按 mtime 降序，且跳过没有任何消息的残file。
    const latest = (await listSessions(dir))[0];
    if (latest) {
      writeCurrentMeta(dir, { id: latest.id, workspaceRoot, createdAt: new Date().toISOString() });
      return new JsonlSession(dir, latest.id);
    }
  }
  return createSession(dir, workspaceRoot);
}

/** JSONL 默认工厂。loop 只依赖 SessionFactory，测试可换成内存表。 */
export const jsonlSessionFactory: SessionFactory = {
  create: createSession,
  open(dir, id) {
    return new JsonlSession(dir, id);
  },
  resumeOrCreate,
};

export interface SessionInfo {
  id: string;
  file: string;
  mtimeMs: number;
  messages: number;
  /** 首条 user 消息预览，帮助用户辨认会话。 */
  preview: string;
  /** --search 时的关键词命中消息条数；仅过滤模式存在。 */
  hits?: number;
  /**
   * 该会话派生的子代理会话数。
   *
   * 子代理会话是独立文件，但**只对主会话有意义**：它就是「主会话里那些 subagent 块」
   * 的落盘实体。列表里带上这个数，用户看到的主会话条目才真的「包含」自己的子代理。
   */
  subagents: number;
  /**
   * 父会话 id；主会话为 undefined。
   *
   * 父子关系没有写在子会话自己的文件里（那会让子会话文件被提前创建），
   * 而是从父会话的 `subagent` start 事件推导——那是唯一的权威来源，且对旧会话天然成立。
   */
  parentId?: string;
}

export interface ListSessionsOptions {
  search?: string;
  /**
   * 连子代理会话一起返回（默认只返回主会话）。
   *
   * 默认关：`/resume` 的语义是「选一个会话继续聊」，而子代理会话是主会话的产物，
   * 直接切进去等于把内部转录当成一次独立对话。按 id 精确查找时需要打开它，
   * 否则无法区分「不存在」和「是子代理会话」。
   */
  includeSubagents?: boolean;
}

/** 扫描期间累积的单文件统计；分类（主/子）要等所有文件扫完才能定。 */
interface SessionScanEntry {
  id: string;
  file: string;
  mtimeMs: number;
  messages: number;
  preview: string;
  hits?: number;
  subagents: number;
}

/**
 * 流式扫描会话目录：单文件可能几 MB，逐行 readline 只取统计与首条 user 预览，
 * 不把整个文件读进内存。带 search 时只返回命中会话并统计命中行数。
 *
 * 默认只返回主会话：子代理会话与主会话同目录，不过滤的话 `/resume` 会被子代理刷屏。
 */
export async function listSessions(dir: string, options?: ListSessionsOptions): Promise<SessionInfo[]> {
  if (!existsSync(dir)) return [];
  const search = options?.search;
  const includeSubagents = options?.includeSubagents === true;
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => join(dir, name));

  const scanned = new Map<string, SessionScanEntry>();
  /** 子会话 id → 父会话 id。跨文件，所以扫完才能下结论。 */
  const parentOf = new Map<string, string>();

  for (const file of files) {
    const info: SessionScanEntry = {
      id: file.split(/[\\/]/).at(-1)!.replace(/\.jsonl$/, ''),
      file,
      mtimeMs: statSync(file).mtimeMs,
      messages: 0,
      preview: '',
      subagents: 0,
    };
    const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
      const record = parseSessionLine(line);
      if (!record) continue;
      if (record.type === 'message') {
        info.messages++;
        if (search && record.content.includes(search)) {
          info.hits = (info.hits ?? 0) + 1;
        }
        if (!info.preview && record.role === 'user') {
          info.preview = record.content.replace(/\s+/g, ' ').slice(0, 96);
        }
        continue;
      }
      // 子代理会话的父子关系只落在父会话的 subagent start 事件里，顺手收下来。
      if (record.kind === 'subagent' && record.data.phase === 'start') {
        const child = record.data.childSessionId;
        // 同一个子会话被多个父会话提及（不该发生）时只认第一个，计数不重复。
        if (typeof child === 'string' && child !== '' && !parentOf.has(child)) {
          parentOf.set(child, info.id);
          info.subagents++;
        }
      }
    }
    scanned.set(info.id, info);
  }

  const out: SessionInfo[] = [];
  for (const info of scanned.values()) {
    if (search && !info.hits) continue;
    // 建了文件却没有对话的（只有事件、或写了空行）：不进列表。
    if (info.messages === 0) continue;
    const parentId = parentOf.get(info.id);
    if (parentId !== undefined && !includeSubagents) continue;
    out.push(parentId === undefined ? { ...info } : { ...info, parentId });
  }
  // mtime 相同（同毫秒批量创建）时按 id 兜底，只为让输出确定——id 是随机 UUID，没有时间含义。
  return out.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (a.id < b.id ? 1 : -1));
}

export function setCurrentSession(dir: string, id: string, workspaceRoot: string): void {
  writeCurrentMeta(dir, { id, workspaceRoot, createdAt: new Date().toISOString() });
}

function writeCurrentMeta(dir: string, meta: SessionMeta): void {
  writeFileSync(metaPath(dir), JSON.stringify(meta, null, 2));
}
