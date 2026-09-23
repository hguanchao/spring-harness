import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnUnrestricted } from '../../sandbox/host-spawn.js';
import { SandboxError, type ConfinedSpawn, type SandboxHandle, type SpawnResult } from '../../sandbox/types.js';
import { landlockGrants, type ConfinedMode, type LandlockGrants } from './profile.js';

/**
 * Landlock 是 bwrap 缺失时的同一条文件策略，不是另一套语义。
 * 执行力度标 partial：内核能提供的访问类随 ABI 变，这里不把它说成完整承诺。
 */
export class LinuxLandlockSandbox implements SandboxHandle {
  readonly status;
  readonly tempDir: string;

  constructor(
    private readonly mode: ConfinedMode,
    private readonly workspaceRoot: string,
    tempDir: string,
  ) {
    this.tempDir = tempDir;
    this.status = { mode, enforcement: 'partial' as const, platform: 'linux' as const };
  }

  async init(): Promise<void> {
    const ok = await landlockUsable(this.grants());
    if (!ok) throw new SandboxError('Landlock probe failed; pass --sandbox off');
  }

  run(options: ConfinedSpawn): Promise<SpawnResult> {
    return runLandlocked(options, this.grants());
  }

  dispose(): void {}

  private grants(): LandlockGrants {
    return landlockGrants(this.mode, this.workspaceRoot, this.tempDir);
  }
}

export function landlockEntryPath(): string {
  const ts = fileURLToPath(new URL('./landlock-entry.ts', import.meta.url));
  if (existsSync(ts)) return ts;
  return fileURLToPath(new URL('./landlock-entry.js', import.meta.url));
}

export function runLandlocked(options: ConfinedSpawn, grants: LandlockGrants): Promise<SpawnResult> {
  return spawnUnrestricted({
    ...options,
    command: process.execPath,
    args: [landlockEntryPath(), JSON.stringify(grants), options.command, ...options.args],
  });
}

export async function landlockUsable(grants: LandlockGrants = landlockGrants('read-only', '/', '/')): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  try {
    const result = await runLandlocked(
      { command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: '/', timeoutMs: 5000 },
      grants,
    );
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
