import { createHash } from 'node:crypto';
import { api, lastError, type Handle } from './win32.js';

export function workspaceWriteSid(workspaceRoot: string): string {
  const digest = createHash('sha256').update(workspaceRoot, 'utf8').digest();
  const first = (digest.readUInt32LE(0) % (2 ** 30 - 1)) + 1;
  const second = (digest.readUInt32LE(4) % (2 ** 30 - 1)) + 1;
  return `S-1-4-${first}-${second}`;
}

export function tempWriteSid(tempDir: string): string {
  const digest = createHash('sha256').update('temp\0', 'utf8').update(tempDir, 'utf8').digest();
  const first = (digest.readUInt32LE(0) % (2 ** 30 - 1)) + 1;
  const second = (digest.readUInt32LE(4) % (2 ** 30 - 1)) + 1;
  return `S-1-4-${first}-${second}-1`;
}

export function sidBuffer(sddl: string): Buffer {
  const slot: [Handle] = [null];
  if (api.convertStringSidToSidW(sddl, slot) === 0 || !slot[0]) {
    throw lastError('ConvertStringSidToSidW', sddl);
  }
  const len = api.getLengthSid(slot[0]);
  const copy = Buffer.alloc(len);
  if (api.copySid(len, copy, slot[0]) === 0) throw lastError('CopySid', sddl);
  api.localFree(slot[0]);
  return copy;
}
