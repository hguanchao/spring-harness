import { canonicalize } from '../../workspace/boundary.js';
import type { ConfinedSpawn, SandboxHandle, SpawnResult } from '../open.js';
import { SandboxError, type SandboxMode, type SandboxStatus } from '../types.js';
import { grantWrite, revokeWrite } from './acl.js';
import { sidBuffer, tempWriteSid, workspaceWriteSid } from './sid.js';
import { drainHandle, readExitCode, spawnAsUser } from './spawn.js';
import {
  createRestrictedToken,
  findLogonSid,
  makeWellKnownSid,
  openCurrentProcessToken,
  setDefaultDaclGrant,
} from './token.js';
import { WinWorldSid, api, type Handle } from './win32.js';

/** 等待-排空循环的步长：足够小以免输出延迟可感，足够大以免空转吃 CPU。 */
const POLL_INTERVAL_MS = 25;

export interface WindowsAclOptions {
  mode: Exclude<SandboxMode, 'off'>;
  workspaceRoot: string;
  sphHomeDir: string;
  tempDir: string;
}

/** Windows restricted-token 后端。强制执行按设计是 partial。 */
export class WindowsAclSandbox implements SandboxHandle {
  readonly status: SandboxStatus;
  readonly tempDir: string;
  private token: Handle | null = null;
  private readonly revocable: { path: string; sid: Handle }[] = [];
  private readonly owned: Handle[] = [];

  constructor(private readonly options: WindowsAclOptions) {
    this.tempDir = options.tempDir;
    this.status = { mode: options.mode, enforcement: 'partial', platform: 'win32' };
  }

  async init(): Promise<void> {
    try {
      const workspace = canonicalize(this.options.workspaceRoot);
      const sphHome = canonicalize(this.options.sphHomeDir);
      const temp = canonicalize(this.options.tempDir);
      const processToken = openCurrentProcessToken();
      this.owned.push(processToken);
      const logon = findLogonSid(processToken);
      const world = makeWellKnownSid(WinWorldSid);
      const writeSids: Buffer[] = [];
      if (this.options.mode === 'workspace') {
        const workspaceSid = workspaceWriteSid(workspace);
        const sphSid = workspaceWriteSid(`${sphHome}\0sph`);
        const tmpSid = tempWriteSid(temp);
        grantWrite(workspace, workspaceSid);
        grantWrite(sphHome, sphSid);
        this.revocable.push({ path: temp, sid: grantWrite(temp, tmpSid) });
        writeSids.push(sidBuffer(workspaceSid), sidBuffer(sphSid), sidBuffer(tmpSid));
      }
      const token = createRestrictedToken(
        processToken,
        logon,
        writeSids,
        world,
        this.options.mode,
      );
      setDefaultDaclGrant(token, this.options.mode === 'workspace' ? writeSids[0] ?? world : world);
      this.token = token;
      this.owned.push(token);
    } catch (error) {
      this.dispose();
      const detail = error instanceof Error ? error.message : String(error);
      throw new SandboxError(`Windows ACL sandbox failed to start: ${detail}`);
    }
  }

  /**
   * 小步等待 + 持续排空管道。
   *
   * 旧实现先 `WaitForSingleObject(整个 timeout)`、进程退出后才读 stdout/stderr：
   * 子进程输出写满管道缓冲区（约 4~64KB）就会阻塞在 write，父进程阻塞在 wait，
   * 双方互等到超时才靠 TerminateProcess 收场——输出略大的命令会「无故超时且丢失输出」。
   * 同时旧实现完全忽略了 spawn.signal，取消在这里是失效的。
   */
  async run(spawn: ConfinedSpawn): Promise<SpawnResult> {
    if (!this.token) throw new SandboxError('sandbox token is not initialized');
    const child = spawnAsUser(this.token, spawn.command, spawn.args, spawn.cwd);
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
    return { stdout: stdout.join(''), stderr: stderr.join(''), exitCode };
  }

  dispose(): void {
    for (const grant of this.revocable) {
      try {
        revokeWrite(grant.path, grant.sid);
      } catch {
        // 退出时清理失败不掩盖启动错误
      }
    }
    this.revocable.length = 0;
    for (const handle of this.owned) {
      try {
        api.closeHandle(handle);
      } catch {
        // ignore
      }
    }
    this.owned.length = 0;
    this.token = null;
  }
}
