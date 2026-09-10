import type { SandboxMode } from './types.js';
import { SandboxError } from './types.js';

export function assertWriteAllowed(mode: SandboxMode, tool: 'write' | 'search_replace' | 'shell'): void {
  if (mode === 'read-only' && (tool === 'write' || tool === 'search_replace')) {
    throw new SandboxError(`${tool} is denied under read-only sandbox`);
  }
}
