import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sphHome } from '../home.js';
import {
  SandboxError,
  type ConfinedSpawn,
  type SandboxHandle,
  type SandboxMode,
  type SandboxStatus,
  type SpawnResult,
} from './types.js';
import type { SandboxBackendFactory } from '../plugins/services.js';

export type { ConfinedSpawn, SandboxHandle, SpawnResult } from './types.js';

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

/**
 * 打开沙箱。
 *
 * `off` 档位核心自理（无约束）。confine 档位（workspace / read-only）**必须由插件提供
 * 后端**：核心只负责 fail-closed——插件缺席时拒绝启动，而不是放开约束。
 *
 * 后端是机制（Windows restricted-token / Linux bwrap 都是「怎么关」），策略是「关到什么
 * 程度」（read-only 下拒绝 write/edit，见 policy.ts）。机制插件化，策略留在核心。
 */
export async function openSandbox(
  mode: SandboxMode,
  workspaceRoot: string,
  backendFactory?: SandboxBackendFactory,
): Promise<SandboxHandle> {
  const tempDir = mkdtempSync(join(tmpdir(), 'sph-'));
  mkdirSync(sphHome(), { recursive: true });
  if (mode === 'off') return new OffSandbox(tempDir);
  if (!backendFactory) {
    rmSync(tempDir, { recursive: true, force: true });
    throw new SandboxError(
      `sandbox ${mode} needs the sph-sandbox plugin; it is not loaded — add it back or pass --sandbox off`,
    );
  }
  try {
    return await backendFactory(mode, workspaceRoot, tempDir);
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}
