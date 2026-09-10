import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOCK_NAME = 'session.lock';

export class SessionLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionLockedError';
  }
}

export function lockPath(sessionDir: string): string {
  return join(sessionDir, LOCK_NAME);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 同工作区第二实例立刻退出，避免两份进程同时 append JSONL。 */
export function acquireSessionLock(sessionDir: string, pid = process.pid): () => void {
  mkdirSync(sessionDir, { recursive: true });
  const path = lockPath(sessionDir);
  if (existsSync(path)) {
    const existing = Number(readFileSync(path, 'utf8').trim());
    if (Number.isInteger(existing) && existing > 0 && isPidAlive(existing)) {
      throw new SessionLockedError(`session already in use by pid ${existing} (${path})`);
    }
    unlinkSync(path);
  }
  writeFileSync(path, String(pid), { flag: 'wx' });
  return () => {
    try {
      unlinkSync(path);
    } catch {
      // 进程退出时锁文件可能已被外部清掉
    }
  };
}
