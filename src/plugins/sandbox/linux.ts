import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { spawnUnrestricted } from './host-spawn.js';
import type { ConfinedSpawn, SandboxHandle, SpawnResult } from './types.js';
import { SandboxError, type SandboxMode } from './types.js';

export function linuxBwrapArgs(
  mode: Exclude<SandboxMode, 'off'>,
  workspaceRoot: string,
  sphHome: string,
  tempDir: string,
): string[] {
  const bindWs = mode === 'read-only' ? '--ro-bind' : '--bind';
  const net = mode === 'read-only' || process.env.SPH_SANDBOX_NET === 'off' ? ['--unshare-net'] : [];
  return [
    '--die-with-parent',
    '--unshare-pid',
    '--unshare-uts',
    '--hostname', 'sph',
    ...net,
    '--dev', '/dev',
    '--proc', '/proc',
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/bin', '/bin',
    '--ro-bind-try', '/lib', '/lib',
    '--ro-bind-try', '/lib64', '/lib64',
    '--ro-bind-try', '/etc', '/etc',
    '--tmpfs', '/tmp',
    bindWs, workspaceRoot, workspaceRoot,
    // 配置/密钥在父进程写；子进程只读 ~/.sph，避免 shell 改 api_key。
    '--ro-bind', sphHome, sphHome,
    '--bind', tempDir, tempDir,
    '--chdir', workspaceRoot,
  ];
}

function resolveBwrap(): string {
  for (const candidate of ['/usr/bin/bwrap', '/bin/bwrap']) {
    if (existsSync(candidate)) return candidate;
  }
  throw new SandboxError('Linux sandbox requires bwrap; pass --sandbox off');
}

export class LinuxBwrapSandbox implements SandboxHandle {
  readonly status;
  readonly tempDir: string;
  private readonly bwrap: string;

  constructor(
    private readonly mode: Exclude<SandboxMode, 'off'>,
    private readonly workspaceRoot: string,
    private readonly sphHomeDir: string,
    tempDir: string,
  ) {
    this.bwrap = resolveBwrap();
    this.tempDir = tempDir;
    this.status = { mode, enforcement: 'partial' as const, platform: process.platform };
  }

  async init(): Promise<void> {
    const probe = spawn(this.bwrap, [...linuxBwrapArgs(this.mode, this.workspaceRoot, this.sphHomeDir, this.tempDir), '--', 'true']);
    const code = await new Promise<number | null>((resolve, reject) => {
      probe.on('error', reject);
      probe.on('close', resolve);
    });
    if (code !== 0) throw new SandboxError(`bwrap probe failed (exit ${code})`);
  }

  run(options: ConfinedSpawn): Promise<SpawnResult> {
    return spawnUnrestricted({
      ...options,
      command: this.bwrap,
      args: [
        ...linuxBwrapArgs(this.mode, this.workspaceRoot, this.sphHomeDir, this.tempDir),
        '--',
        options.command,
        ...options.args,
      ],
    });
  }

  dispose(): void {}
}
