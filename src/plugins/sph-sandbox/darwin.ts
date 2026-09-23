import { existsSync, realpathSync } from 'node:fs';
import { spawnUnrestricted } from '../../sandbox/host-spawn.js';
import { SandboxError, type ConfinedSpawn, type SandboxHandle, type SpawnResult } from '../../sandbox/types.js';
import { seatbeltArgs, type ConfinedMode } from './profile.js';

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * macOS 同机策略：sandbox-exec 的 Seatbelt。允许读和网络，拒绝文件写，再按档放行。
 * 依赖系统自带的 sandbox-exec；Apple 若拿掉它，这一档就只能关。
 */
export class DarwinSeatbeltSandbox implements SandboxHandle {
  readonly status;
  readonly tempDir: string;
  private readonly args: string[];

  constructor(mode: ConfinedMode, workspaceRoot: string, tempDir: string) {
    this.tempDir = tempDir;
    this.args = seatbeltArgs(mode, canonical(workspaceRoot), canonical(tempDir));
    this.status = { mode, enforcement: 'full' as const, platform: 'darwin' as const };
  }

  async init(): Promise<void> {
    if (!existsSync(SANDBOX_EXEC)) {
      throw new SandboxError('macOS sandbox requires /usr/bin/sandbox-exec; pass --sandbox off');
    }
    const result = await spawnUnrestricted({
      command: SANDBOX_EXEC,
      args: [...this.args, '/usr/bin/true'],
      cwd: '/',
      timeoutMs: 5000,
    });
    if (result.exitCode !== 0) {
      throw new SandboxError(`sandbox-exec probe failed (exit ${result.exitCode})`);
    }
  }

  run(options: ConfinedSpawn): Promise<SpawnResult> {
    return spawnUnrestricted({
      ...options,
      command: SANDBOX_EXEC,
      args: [...this.args, options.command, ...options.args],
    });
  }

  dispose(): void {}
}
