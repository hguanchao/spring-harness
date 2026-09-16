import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sphSessionsRoot } from '../home.js';

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

/**
 * 是否还有**别的** sph 进程活着（跨工作区）。
 *
 * 动机：Windows 沙箱对 `~/.sph` 的写授权是**机器级共享**的——能力 SID 由 sphHome 路径派生，
 * 所有工作区算出来是同一个。退出时撤销会连累另一个正在跑的工作区里的 shell（它们的受限 token
 * 正靠这条授权写 ~/.sph），而那条会话在本进程退出前不会重新申请授权。所以撤销前先问一句，
 * 还有别人活着就留给最后一个退出的进程收。
 *
 * 工作区授权没有这个问题：它受会话锁保护，同一工作区同时只允许一个实例。
 *
 * 判断依据就是各工作区目录里的 session.lock（已有状态，不新增簿记）。扫描不到或读不出来
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
    const path = lockPath(join(root, name));
    let raw: string;
    try {
      if (!existsSync(path)) continue;
      raw = readFileSync(path, 'utf8').trim();
    } catch {
      continue;
    }
    const pid = Number(raw);
    if (Number.isInteger(pid) && pid > 0 && pid !== ownPid && isPidAlive(pid)) return true;
  }
  return false;
}
