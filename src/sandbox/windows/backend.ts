import { errorMessage } from '../../util.js';
import { canonicalize } from '../../workspace/boundary.js';
import { hasOtherLiveSessionIn } from '../../session/lock.js';
import { sessionDirFor } from '../../session/path.js';
import type { ConfinedSpawn, SandboxHandle, SpawnResult } from '../types.js';
import { SandboxError, type SandboxMode, type SandboxStatus } from '../types.js';
import { grantWrite, revokeWrite } from './acl.js';
import { sidBuffer, tempWriteSid, workspaceWriteSid } from './sid.js';
import { capSpawnOutput } from '../env.js';
import { drainHandle, readExitCode, spawnAsUser } from './spawn.js';
import {
  createFilteredToken,
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

/**
 * 按 spawn 的 shell 二进制分档（见类注释）。
 *
 * argv 里只会出现 bash/pwsh 两种（shellArgv 决定），但规则仍要给出未知二进制的
 * 归宿：按围栏意图归入受限档——宁可让一个意外运行时启动失败，也不要让它拿着
 * 无围栏的令牌满盘写。
 */
export function tokenTierFor(command: string): 'filtered' | 'restricted' {
  const base = (command.split(/[\\/]/).pop() ?? command).replace(/\.exe$/i, '').toLowerCase();
  if (base === 'bash' || base === 'sh') return 'filtered';
  return 'restricted';
}

/**
 * Windows 沙箱后端：按 shell 分档的双令牌。
 *
 * - pwsh（.NET 运行时）→ **受限令牌 + ACL 写围栏**：`CreateRestrictedToken` 挂
 *   登录 SID + Everyone（保活不变式）+ 能力 SID；写访问做「正常检查 ∩ 受限检查」
 *   交集，工作区与私有临时目录之外的写一律被拒。TMP/TEMP 重写到私有临时目录，
 *   pwsh 的程序集探针才能落进已授权的位置（否则保守降级 ConstrainedLanguage）。
 *   这是 dsh windows-acl 方案验证过的有效域。
 * - bash（msys/cygwin 运行时）→ **过滤令牌**：cygwin 初始化要创建只授「用户 SID」
 *   的共享节与信号管道，受限列表把它拒掉（couldn't create signal pipe）——受限
 *   围栏与 cygwin 对象模型根本冲突。bash 只保留 LUA + 剥特权，写入边界落在工具层
 *   策略与审批。
 *
 * 强制执行按设计是 partial：工作区授权走能力 ACE（Everyone 授予的写与 NTFS 硬链接
 * 别名围不住），bash 档没有文件围栏。
 */
export class WindowsAclSandbox implements SandboxHandle {
  readonly status: SandboxStatus;
  readonly tempDir: string;
  private restrictedToken: Handle | null = null;
  private filteredToken: Handle | null = null;
  /**
   * 退出时要撤销的授权。
   * `workspace` = 同目录多实例共用一条 ACE，会话全退才撤。
   */
  private readonly revocable: { path: string; sddl: string; retain?: 'workspace' }[] = [];
  private readonly owned: Handle[] = [];

  constructor(private readonly options: WindowsAclOptions) {
    this.tempDir = options.tempDir;
    this.status = { mode: options.mode, enforcement: 'partial', platform: 'win32' };
  }

  async init(): Promise<void> {
    try {
      const workspace = canonicalize(this.options.workspaceRoot);
      const temp = canonicalize(this.options.tempDir);
      const processToken = openCurrentProcessToken();
      this.owned.push(processToken);
      const logon = findLogonSid(processToken);
      const world = makeWellKnownSid(WinWorldSid);

      // 受限档（pwsh）：workspace 档位给工作区与私有临时目录加可继承写授权。
      // 不给 ~/.sph 授写：配置/会话/密钥由父进程写，沙箱子进程不该改 api_key。
      const writeSids: Buffer[] = [];
      if (this.options.mode === 'workspace') {
        const workspaceSid = workspaceWriteSid(workspace);
        const tmpSid = tempWriteSid(temp);
        const grants: Array<{ path: string; sddl: string; retain?: 'workspace' }> = [
          { path: workspace, sddl: workspaceSid, retain: 'workspace' },
          { path: temp, sddl: tmpSid },
        ];
        for (const grant of grants) {
          grantWrite(grant.path, grant.sddl);
          // 授一条记一条：只撤销真正生效过的，中途失败也不会去动没改过的 DACL。
          this.revocable.push(grant);
        }
        writeSids.push(sidBuffer(workspaceSid), sidBuffer(tmpSid));
      }
      const restricted = createRestrictedToken(processToken, logon, writeSids, world, this.options.mode);
      setDefaultDaclGrant(restricted, this.options.mode === 'workspace' ? writeSids[0] ?? world : world);
      this.restrictedToken = restricted;
      this.owned.push(restricted);

      // 过滤档（bash）：剥特权但不挂受限列表，msys bash 才活得过初始化。
      const filtered = createFilteredToken(processToken);
      this.filteredToken = filtered;
      this.owned.push(filtered);
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
    const tier = tokenTierFor(spawn.command);
    const token = tier === 'filtered' ? this.filteredToken : this.restrictedToken;
    if (!token) throw new SandboxError('sandbox token is not initialized');
    // 受限档把 TMP/TEMP 指到私有临时目录：pwsh 的程序集探针要写已授权的位置。
    const envExtra = tier === 'restricted' ? { TMP: this.tempDir, TEMP: this.tempDir } : undefined;
    const child = spawnAsUser(token, spawn.command, spawn.args, spawn.cwd, envExtra);
    const stdout: string[] = [];
    const stderr: string[] = [];
    let exitCode: number | null = null;
    const deadline = Date.now() + spawn.timeoutMs;
    try {
      for (;;) {
        // abort 与超时同一归宿。只跳出等待的话进程还在跑，shell 又把拿不到的退出码印成 timeout。
        if (spawn.signal?.aborted) {
          api.terminateProcess(child.process, 1);
          api.waitForSingleObject(child.process, 5_000);
          exitCode = readExitCode(child.process);
          break;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          api.terminateProcess(child.process, 1);
          break;
        }
        // 同步 Wait 会占死事件循环：TUI 的取消、signal.abort 都排不进来，上面的分支永远看不到。
        // 先非阻塞看一眼进程，再把这 25ms 让给事件循环；管道仍按这个间隔排空，避免写满互锁。
        const waited = api.waitForSingleObject(child.process, 0);
        drainHandle(child.stdout, stdout);
        drainHandle(child.stderr, stderr);
        if (waited === 0) {
          exitCode = readExitCode(child.process);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)));
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
    // 工作区授权是同目录多实例共享的：别人还活着就跳过，留给最后一个退出的进程收——
    // 否则会留下「授权被别的进程悄悄撤掉」的间歇性写失败，比脏 ACE 难查得多。
    const dropWorkspace = !hasOtherLiveSessionIn(sessionDirFor(this.options.workspaceRoot));
    for (const grant of this.revocable) {
      if (grant.retain === 'workspace' && !dropWorkspace) continue;
      try {
        revokeWrite(grant.path, grant.sddl);
      } catch {
        // 退出时清理失败不掩盖启动错误
      }
    }
    for (const handle of this.owned) {
      try {
        api.closeHandle(handle);
      } catch {
        // ignore
      }
    }
    this.owned.length = 0;
    this.restrictedToken = null;
    this.filteredToken = null;
  }
}
