import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sphSessionsRoot } from '../home.js';

export class SessionLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionLockedError';
  }
}

/** 锁按会话 id 落盘：同一工作区可以开多个 sph，但不能两个进程写同一份 JSONL。 */
export function lockPath(sessionDir: string, sessionId: string): string {
  return join(sessionDir, `${sessionId}.lock`);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function livePidAt(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8').trim();
  } catch {
    return undefined;
  }
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return isPidAlive(pid) ? pid : undefined;
}

/**
 * 锁住这一份会话文件。同工作区的其它会话互不影响。
 *
 * 两个进程同时 append 同一份 JSONL 会把半行写穿；`-c` / `--resume` 撞上已打开的
 * 同一 id 才拒绝。默认新建会话不会撞锁。
 */
export function acquireSessionLock(sessionDir: string, sessionId: string, pid = process.pid): () => void {
  mkdirSync(sessionDir, { recursive: true });
  const path = lockPath(sessionDir, sessionId);
  const existing = livePidAt(path);
  if (existing !== undefined) {
    throw new SessionLockedError(
      `session ${sessionId} already in use by pid ${existing}\nstart without -c/--resume to open a new conversation in this directory.`,
    );
  }
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // 死锁文件清不掉时走下面 wx，EEXIST 同样报占用
    }
  }
  try {
    writeFileSync(path, String(pid), { flag: 'wx' });
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
    if (code === 'EEXIST') {
      throw new SessionLockedError(
        `session ${sessionId} already in use (${path})\nstart without -c/--resume to open a new conversation in this directory.`,
      );
    }
    throw error;
  }
  return () => {
    try {
      unlinkSync(path);
    } catch {
      // 进程退出时锁文件可能已被外部清掉
    }
  };
}

function dirHasOtherLiveLock(dir: string, ownPid: number): boolean {
  let names: string[];
  try {
    if (!existsSync(dir)) return false;
    names = readdirSync(dir);
  } catch {
    return false;
  }
  for (const name of names) {
    if (!name.endsWith('.lock')) continue;
    const pid = livePidAt(join(dir, name));
    if (pid !== undefined && pid !== ownPid) return true;
  }
  return false;
}

/**
 * 这个工作区目录里是否还有**别的** sph 进程活着。
 *
 * Windows 工作区 ACL 的能力 SID 由路径派生，同目录多实例共享一条 ACE；先退出的
 * 那个不能把授权撤掉。
 */
export function hasOtherLiveSessionIn(sessionDir: string, ownPid = process.pid): boolean {
  return dirHasOtherLiveLock(sessionDir, ownPid);
}

/**
 * 是否还有**别的** sph 进程活着（跨工作区）。
 *
 * 动机：Windows 沙箱对 `~/.sph` 的写授权是**机器级共享**的——能力 SID 由 sphHome 路径派生，
 * 所有工作区算出来是同一个。退出时撤销会连累另一个正在跑的工作区里的 shell（它们的受限 token
 * 正靠这条授权写 ~/.sph），而那条会话在本进程退出前不会重新申请授权。所以撤销前先问一句，
 * 还有别人活着就留给最后一个退出的进程收。
 *
 * 判断依据是各工作区目录里的 `*.lock`（含旧的 `session.lock`）。扫描不到或读不出来
 * 一律当作「没有别人」——宁可多撤销一次，也不要把授权永久留在盘上。
 */
export function hasOtherLiveSession(ownPid = process.pid, root = sphSessionsRoot()): boolean {
  let names: string[];
  try {
    if (!existsSync(root)) return false;
    names = readdirSync(root);
  } catch {
    return false;
  }
  for (const name of names) {
    if (dirHasOtherLiveLock(join(root, name), ownPid)) return true;
  }
  return false;
}
