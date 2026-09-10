import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sphHome } from '../home.js';
import { SandboxError, type SandboxMode, type SandboxStatus } from './types.js';

export interface ConfinedSpawn {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface SandboxHandle {
  status: SandboxStatus;
  tempDir: string;
  run(spawn: ConfinedSpawn): Promise<SpawnResult>;
  dispose(): void;
}

class OffSandbox implements SandboxHandle {
  readonly status: SandboxStatus = { mode: 'off', enforcement: 'none', platform: process.platform };
  readonly tempDir: string;

  constructor(tempDir: string) {
    this.tempDir = tempDir;
  }

  async run(spawn: ConfinedSpawn): Promise<SpawnResult> {
    const { spawnUnrestricted } = await import('./host-spawn.js');
    return spawnUnrestricted(spawn);
  }

  dispose(): void {}
}

/** confine 档位 fail-closed：Windows ACL 或 Linux bwrap；macOS 直接拒绝。 */
export async function openSandbox(mode: SandboxMode, workspaceRoot: string): Promise<SandboxHandle> {
  const tempDir = mkdtempSync(join(tmpdir(), 'sph-'));
  mkdirSync(sphHome(), { recursive: true });
  if (mode === 'off') return new OffSandbox(tempDir);
  if (process.platform === 'win32') {
    const { WindowsAclSandbox } = await import('./windows/backend.js');
    const backend = new WindowsAclSandbox({
      mode,
      workspaceRoot,
      sphHomeDir: sphHome(),
      tempDir,
    });
    await backend.init();
    return backend;
  }
  if (process.platform === 'linux') {
    const { LinuxBwrapSandbox } = await import('./linux.js');
    const backend = new LinuxBwrapSandbox(mode, workspaceRoot, sphHome(), tempDir);
    await backend.init();
    return backend;
  }
  throw new SandboxError(`sandbox ${mode} is not supported on ${process.platform}; pass --sandbox off`);
}
