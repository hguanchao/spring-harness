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

/**
 * 按 SDDL 串改一次目标路径的 DACL。
 *
 * SID 的分配与释放收在这里，而不是让调用方保管句柄：
 * `ConvertStringSidToSidW` 用 LocalAlloc 分配，旧实现把它返回的句柄一路带着走、从不 LocalFree，
 * 每次 grant/revoke 都漏一块本地内存。SetEntriesInAclW 会把 SID **复制**进新 ACL，所以
 * setEntriesInAclW 返回后立刻释放是安全的。
 */
function apply(path: string, sddl: string, mode: number, permissions: number): void {
  const sid = parseSid(sddl);
  try {
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
  } finally {
    api.localFree(sid);
  }
}

/** 给路径加上一条可继承的写授权（给沙箱 token 持有的能力 SID）。 */
export function grantWrite(path: string, sddl: string): void {
  apply(path, sddl, GRANT_ACCESS, GRANT_MASK);
}

/** 撤销同一能力 SID 的授权，把 DACL 还原到授权之前的样子。 */
export function revokeWrite(path: string, sddl: string): void {
  apply(path, sddl, REVOKE_ACCESS, 0);
}
