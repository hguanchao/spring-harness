import {
  api,
  DACL_SECURITY_INFORMATION,
  ERROR_SUCCESS,
  GRANT_ACCESS,
  GRANT_MASK,
  REVOKE_ACCESS,
  SE_FILE_OBJECT,
  explicitAccessEntry,
  lastError,
  win32Error,
  type Handle,
} from './win32.js';

function parseSid(sddl: string): Handle {
  const slot: [Handle] = [null];
  if (api.convertStringSidToSidW(sddl, slot) === 0) throw lastError('ConvertStringSidToSidW', sddl);
  if (!slot[0]) throw lastError('ConvertStringSidToSidW', 'null');
  return slot[0];
}

function apply(path: string, sid: Handle, mode: number, permissions: number): void {
  const dacl: [Handle] = [null];
  const sd: [Handle] = [null];
  const read = api.getNamedSecurityInfoW(
    path,
    SE_FILE_OBJECT,
    DACL_SECURITY_INFORMATION,
    null,
    null,
    dacl,
    null,
    sd,
  );
  if (read !== ERROR_SUCCESS) throw win32Error('GetNamedSecurityInfoW', read, path);
  const newAcl: [Handle] = [null];
  const merged = api.setEntriesInAclW(1, explicitAccessEntry(sid, mode, permissions), dacl[0], newAcl);
  if (sd[0]) api.localFree(sd[0]);
  if (merged !== ERROR_SUCCESS) throw win32Error('SetEntriesInAclW', merged, path);
  const written = api.setNamedSecurityInfoW(
    path,
    SE_FILE_OBJECT,
    DACL_SECURITY_INFORMATION,
    null,
    null,
    newAcl[0],
    null,
  );
  if (newAcl[0]) api.localFree(newAcl[0]);
  if (written !== ERROR_SUCCESS) throw win32Error('SetNamedSecurityInfoW', written, path);
}

export function grantWrite(path: string, sddl: string): Handle {
  const sid = parseSid(sddl);
  apply(path, sid, GRANT_ACCESS, GRANT_MASK);
  return sid;
}

export function revokeWrite(path: string, sid: Handle): void {
  apply(path, sid, REVOKE_ACCESS, 0);
}
