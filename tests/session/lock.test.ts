import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { acquireSessionLock, SessionLockedError, hasOtherLiveSession, hasOtherLiveSessionIn, lockPath } from '../../src/plugins/sph-session/lock.js';

/**
 * `hasOtherLiveSession` 决定 Windows 沙箱退出时要不要撤销 `~/.sph` 的共享写授权
 * （见 sandbox/windows/backend.ts）。判断错了有两个方向的后果：
 * 误判成「有别人」→ 授权永久留在盘上；误判成「没别人」→ 撤掉另一个会话正在用的授权，
 * 那边会开始间歇性写失败。所以三个分支都钉住。root 可注入，测试不碰真实的 ~/.sph。
 */

describe('hasOtherLiveSession', () => {
  it('会话根目录不存在时返回 false', () => {
    assert.equal(hasOtherLiveSession(process.pid, join(tmpdir(), 'sph-nonexistent-root-xyz')), false);
  });

  it('锁文件是本进程自己的 pid 时不算「别人」', () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-lock-self-'));
    try {
      const dir = join(root, 'ws-a');
      mkdirSync(dir, { recursive: true });
      writeFileSync(lockPath(dir, 'self'), String(process.pid));
      assert.equal(hasOtherLiveSession(process.pid, root), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('锁文件里的 pid 已死时不算「别人」', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-lock-dead-'));
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      await once(child, 'spawn');
      const pid = child.pid;
      assert.ok(pid !== undefined);
      const dir = join(root, 'ws-b');
      mkdirSync(dir, { recursive: true });
      writeFileSync(lockPath(dir, 'other'), String(pid));

      assert.equal(hasOtherLiveSession(process.pid, root), true, '活着的外来进程要能认出来');

      child.kill();
      await once(child, 'exit');
      assert.equal(hasOtherLiveSession(process.pid, root), false, '进程退出后不该再拦住撤销');
      assert.equal(hasOtherLiveSessionIn(dir, process.pid), false);
    } finally {
      child.kill();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('acquireSessionLock', () => {
  it('同一会话挡住第二个实例，释放后可重新获取', () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-lock-'));
    try {
      const dir = join(root, 'ws');
      const release = acquireSessionLock(dir, 'sess-a');
      assert.throws(() => acquireSessionLock(dir, 'sess-a'), SessionLockedError);
      release();
      const again = acquireSessionLock(dir, 'sess-a');
      again();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('同一工作区不同会话可以同时持锁', () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-lock-multi-'));
    try {
      const dir = join(root, 'ws');
      const a = acquireSessionLock(dir, 'sess-a');
      const b = acquireSessionLock(dir, 'sess-b');
      a();
      b();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
