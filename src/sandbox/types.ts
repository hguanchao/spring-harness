export type SandboxMode = 'off' | 'workspace' | 'read-only';
export type SandboxEnforcement = 'none' | 'partial';

export interface SandboxStatus {
  mode: SandboxMode;
  enforcement: SandboxEnforcement;
  platform: NodeJS.Platform;
}

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

/** 打开一个沙箱；默认实现按 OS 分发，测试与自定义入口可注入。 */
export type SandboxFactory = (mode: SandboxMode, workspaceRoot: string) => Promise<SandboxHandle>;

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxError';
  }
}
