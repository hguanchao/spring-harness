import { appendFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { messagesOf } from './query.js';
import type { SessionMessage, SessionRecord } from './types.js';

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
function parseRecords(text: string): SessionRecord[] {
  const out: SessionRecord[] = [];
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record === null || typeof record !== 'object') continue;
    const type = (record as { type?: unknown }).type;
    if (type === 'message' || type === 'event') out.push(record as SessionRecord);
  }
  return out;
}

export class JsonlSession {
  readonly dir: string;
  readonly id: string;
  readonly file: string;

  constructor(dir: string, id: string) {
    this.dir = dir;
    this.id = id;
    this.file = join(dir, `${id}.jsonl`);
  }

  append(record: SessionRecord): void {
    appendFileSync(this.file, `${JSON.stringify(record)}\n`, 'utf8');
  }

  appendMessage(message: Omit<SessionMessage, 'type' | 'ts'>): void {
    this.append({ type: 'message', ts: new Date().toISOString(), ...message });
  }

  readAll(): SessionRecord[] {
    if (!existsSync(this.file)) return [];
    return parseRecords(readFileSync(this.file, 'utf8'));
  }

  /** 原始行（不解析）。给只做子串预筛的调用方用，省掉全量 JSON.parse。 */
  readLines(): string[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, 'utf8').split('\n');
  }

  readMessages(): SessionMessage[] {
    return messagesOf(this.readAll());
  }
}

function metaPath(dir: string): string {
  return join(dir, 'current.json');
}

export function createSession(dir: string, workspaceRoot: string, makeCurrent = true): JsonlSession {
  mkdirSync(dir, { recursive: true });
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const meta: SessionMeta = { id, workspaceRoot, createdAt: new Date().toISOString() };
  if (makeCurrent) writeFileSync(metaPath(dir), JSON.stringify(meta, null, 2));
  const session = new JsonlSession(dir, id);
  session.append({ type: 'event', ts: meta.createdAt, kind: 'session_start', data: { id, workspaceRoot } });
  return session;
}

export function forkSession(dir: string, source: JsonlSession, workspaceRoot: string): JsonlSession {
  const next = createSession(dir, workspaceRoot);
  for (const record of source.readAll()) {
    if (record.type === 'event' && record.kind === 'session_start') continue;
    next.append(record);
  }
  next.append({
    type: 'event',
    ts: new Date().toISOString(),
    kind: 'session_fork',
    data: { from: source.id, to: next.id },
  });
  return next;
}

export function resumeOrCreate(dir: string, workspaceRoot: string, forceNew: boolean): JsonlSession {
  mkdirSync(dir, { recursive: true });
  if (!forceNew && existsSync(metaPath(dir))) {
    const meta = JSON.parse(readFileSync(metaPath(dir), 'utf8')) as SessionMeta;
    const file = join(dir, `${meta.id}.jsonl`);
    if (existsSync(file)) return new JsonlSession(dir, meta.id);
  }
  const latest = latestJsonl(dir);
  if (!forceNew && latest) {
    const id = latest.replace(/\.jsonl$/, '');
    writeFileSync(metaPath(dir), JSON.stringify({ id, workspaceRoot, createdAt: new Date().toISOString() }, null, 2));
    return new JsonlSession(dir, id);
  }
  return createSession(dir, workspaceRoot);
}

function latestJsonl(dir: string): string | undefined {
  const files = readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort();
  return files.at(-1);
}

export interface SessionInfo {
  id: string;
  file: string;
  mtimeMs: number;
  messages: number;
  /** 首条 user 消息预览，帮助用户辨认会话。 */
  preview: string;
  /** --search 时的关键词命中消息条数；仅过滤模式存在。 */
  hits?: number;
}

/**
 * 流式扫描会话目录：单文件可能几 MB，逐行 readline 只取统计与首条 user 预览，
 * 不把整个文件读进内存。带 search 时只返回命中会话并统计命中行数。
 */
export async function listSessions(dir: string, options?: { search?: string }): Promise<SessionInfo[]> {
  if (!existsSync(dir)) return [];
  const search = options?.search;
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => join(dir, name));
  const out: SessionInfo[] = [];
  for (const file of files) {
    const info: SessionInfo = {
      id: file.split(/[\\/]/).at(-1)!.replace(/\.jsonl$/, ''),
      file,
      mtimeMs: statSync(file).mtimeMs,
      messages: 0,
      preview: '',
    };
    const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let record: SessionRecord;
      try {
        record = JSON.parse(line) as SessionRecord;
      } catch {
        continue;
      }
      if (record.type !== 'message') continue;
      info.messages++;
      if (search && record.content.includes(search)) {
        info.hits = (info.hits ?? 0) + 1;
      }
      if (!info.preview && record.role === 'user') {
        info.preview = record.content.replace(/\s+/g, ' ').slice(0, 96);
      }
    }
    if (search && !info.hits) continue;
    out.push(info);
  }
  // mtime 相同（同毫秒批量创建）时按 id（ISO 时间戳前缀）保序，列表输出确定。
  return out.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (a.id < b.id ? 1 : -1));
}

export function setCurrentSession(dir: string, id: string, workspaceRoot: string): void {
  writeFileSync(
    metaPath(dir),
    JSON.stringify({ id, workspaceRoot, createdAt: new Date().toISOString() }, null, 2),
  );
}
