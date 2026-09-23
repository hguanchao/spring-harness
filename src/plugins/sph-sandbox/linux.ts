import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { spawnUnrestricted } from '../../sandbox/host-spawn.js';
import type { ConfinedSpawn, SandboxHandle, SpawnResult } from '../../sandbox/types.js';
import { SandboxError } from '../../sandbox/types.js';
import { bwrapProfileArgs, type ConfinedMode } from './profile.js';

const BWRAP_CANDIDATES = ['/usr/bin/bwrap', '/bin/bwrap'];

export function findBwrap(exists: (path: string) => boolean = existsSync): string | undefined {
  return BWRAP_CANDIDATES.find((candidate) => exists(candidate));
}

export class LinuxBwrapSandbox implements SandboxHandle {
  readonly status;
  readonly tempDir: string;
  private readonly bwrap: string;

  constructor(
    private readonly mode: ConfinedMode,
    private readonly workspaceRoot: string,
    tempDir: string,
    bwrap: string,
  ) {
    this.bwrap = bwrap;
    this.tempDir = tempDir;
    this.status = { mode, enforcement: 'full' as const, platform: 'linux' as const };
  }

  async init(): Promise<void> {
    const code = await probeExit(this.bwrap, [...this.profile(), '--', '/usr/bin/true']);
    if (code !== 0) throw new SandboxError(`bwrap probe failed (exit ${code})`);
  }

  run(options: ConfinedSpawn): Promise<SpawnResult> {
    return spawnUnrestricted({
      ...options,
      command: this.bwrap,
      args: [...this.profile(), '--', options.command, ...options.args],
    });
  }

  dispose(): void {}

  private profile(): string[] {
    return bwrapProfileArgs(this.mode, this.workspaceRoot, this.tempDir);
  }
}

export function probeExit(command: string, args: string[]): Promise<number | null> {
  const child = spawn(command, args, { stdio: 'ignore' });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
}

export async function bwrapUsable(mode: ConfinedMode, workspaceRoot: string, tempDir: string): Promise<boolean> {
  const bwrap = findBwrap();
  if (!bwrap) return false;
  try {
    const code = await probeExit(bwrap, [...bwrapProfileArgs(mode, workspaceRoot, tempDir), '--', '/usr/bin/true']);
    return code === 0;
  } catch {
    return false;
  }
}
