import { errorMessage } from '../../util.js';
import type { ConfinedSpawn, SandboxHandle, SpawnResult } from '../types.js';
import { SandboxError, type SandboxMode, type SandboxStatus } from '../types.js';
import { capSpawnOutput } from '../env.js';
import { drainHandle, readExitCode, spawnAsUser } from './spawn.js';
import { createFilteredToken, openCurrentProcessToken } from './token.js';
import { api, type Handle } from './win32.js';

/** 等待-排空循环的步长：足够小以免输出延迟可感，足够大以免空转吃 CPU。 */
const POLL_INTERVAL_MS = 25;

export interface WindowsAclOptions {
  mode: Exclude<SandboxMode, 'off'>;
  workspaceRoot: string;
  sphHomeDir: string;
  tempDir: string;
}

/**
 * Windows 沙箱后端：过滤令牌（LUA + 剥特权）。
 *
 * 曾经的方案是 CreateRestrictedToken 加受限 SID 列表做文件系统围栏（WRITE_RESTRICTED），
 * 但 msys/cygwin 运行时初始化时要创建只有「用户 SID」授权的共享节与信号管道，写受限检查
 * 直接把它拒了（couldn't create signal pipe / CreateFileMapping, error 5）——真 Git Bash
 * 在受限令牌下活不过启动。受限列表与 cygwin 的对象模型是根本性冲突，不是单个 DACL 能补的。
 *
 * 所以退到 pi 验证过的立场（SECURITY.md: "intentionally does not have a sandbox"）：
 * 写入边界交给工具层的沙箱策略与审批，OS 层只保留两个无副作用的削减——
 * LUA_TOKEN（过滤管理组、降为标准用户）+ DISABLE_MAX_PRIVILEGE（剥掉高特权）。
 * 实验验证这两者单独/组合都不影响 msys bash 启动。
 */
export class WindowsAclSandbox implements SandboxHandle {
  readonly status: SandboxStatus;
  readonly tempDir: string;
  private tokenHandle: Handle | null = null;
  private readonly owned: Handle[] = [];

  constructor(options: WindowsAclOptions) {
    this.tempDir = options.tempDir;
    this.status = { mode: options.mode, enforcement: 'partial', platform: 'win32' };
  }

  async init(): Promise<void> {
    try {
      const processToken = openCurrentProcessToken();
      this.owned.push(processToken);
      const token = createFilteredToken(processToken);
      this.tokenHandle = token;
      this.owned.push(token);
    } catch (error) {
      this.dispose();
      const detail = errorMessage(error);
      throw new SandboxError(`Windows sandbox failed to start: ${detail}`);
    }
  }

  /**
   * 小步等待 + 持续排空管道（与旧实现的互锁问题同源，见 spawn.drainHandle 注释）。
   */
  async run(spawn: ConfinedSpawn): Promise<SpawnResult> {
    if (!this.tokenHandle) throw new SandboxError('sandbox token is not initialized');
    const child = spawnAsUser(this.tokenHandle, spawn.command, spawn.args, spawn.cwd);
    const stdout: string[] = [];
    const stderr: string[] = [];
    let exitCode: number | null = null;
    const deadline = Date.now() + spawn.timeoutMs;
    try {
      for (;;) {
        if (spawn.signal?.aborted) break;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          api.terminateProcess(child.process, 1);
          break;
        }
        const waited = api.waitForSingleObject(child.process, Math.min(POLL_INTERVAL_MS, remaining));
        drainHandle(child.stdout, stdout);
        drainHandle(child.stderr, stderr);
        if (waited === 0) {
          exitCode = readExitCode(child.process);
          break;
        }
      }
      // 进程已退出/被终止，管道里可能还压着最后一段输出。
      drainHandle(child.stdout, stdout);
      drainHandle(child.stderr, stderr);
    } finally {
      api.closeHandle(child.stdout);
      api.closeHandle(child.stderr);
      api.closeHandle(child.thread);
      api.closeHandle(child.process);
    }
    return { stdout: capSpawnOutput(stdout.join('')), stderr: capSpawnOutput(stderr.join('')), exitCode: exitCode };
  }

  dispose(): void {
    for (const handle of this.owned) {
      try {
        api.closeHandle(handle);
      } catch {
        // ignore
      }
    }
    this.owned.length = 0;
    this.tokenHandle = null;
  }
}
