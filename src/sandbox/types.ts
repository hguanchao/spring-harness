export type SandboxMode = 'off' | 'workspace' | 'read-only';
export type SandboxEnforcement = 'none' | 'partial';

export interface SandboxStatus {
  mode: SandboxMode;
  enforcement: SandboxEnforcement;
  platform: NodeJS.Platform;
}

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxError';
  }
}
