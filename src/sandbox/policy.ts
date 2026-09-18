import type { SandboxMode } from './types.js';
import { SandboxError } from './types.js';

export function assertWriteAllowed(mode: SandboxMode, tool: 'write' | 'edit'): void {
  if (mode === 'read-only' && (tool === 'write' || tool === 'edit')) {
    throw new SandboxError(`${tool} is denied under read-only sandbox`);
  }
}
