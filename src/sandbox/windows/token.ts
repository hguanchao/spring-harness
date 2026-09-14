import {
  api,
  DISABLE_MAX_PRIVILEGE,
  FILE_ALL_ACCESS,
  GRANT_ACCESS,
  LUA_TOKEN,
  PROCESS_QUERY_INFORMATION,
  SE_GROUP_LOGON_ID,
  SECURITY_MAX_SID_SIZE,
  SID_AND_ATTRIBUTES,
  SID_AND_ATTRIBUTES_SIZE,
  SUB_CONTAINERS_AND_OBJECTS_INHERIT,
  TOKEN_ADJUST_DEFAULT,
  TOKEN_ASSIGN_PRIMARY,
  TOKEN_DUPLICATE,
  TOKEN_GROUPS_OFFSET,
  TOKEN_QUERY,
  TokenDefaultDacl,
  TokenGroups,
  WRITE_RESTRICTED,
  explicitAccessEntry,
  lastError,
  type Handle,
} from './win32.js';
import koffi from 'koffi';

export function openCurrentProcessToken(): Handle {
  const processHandle = api.openProcess(PROCESS_QUERY_INFORMATION, 0, process.pid);
  if (!processHandle) throw lastError('OpenProcess', `pid ${process.pid}`);
  const slot: [Handle] = [null];
  const opened = api.openProcessToken(
    processHandle,
    TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ADJUST_DEFAULT | TOKEN_ASSIGN_PRIMARY,
    slot,
  );
  api.closeHandle(processHandle);
  if (opened === 0 || !slot[0]) throw lastError('OpenProcessToken');
  return slot[0];
}

export function findLogonSid(token: Handle): Buffer {
  const needed: [number] = [0];
  api.getTokenInformation(token, TokenGroups, null, 0, needed);
  if (needed[0] === 0) throw lastError('GetTokenInformation', 'TokenGroups size');
  const groups = Buffer.alloc(needed[0]);
  if (api.getTokenInformation(token, TokenGroups, groups, groups.length, needed) === 0) {
    throw lastError('GetTokenInformation', 'TokenGroups');
  }
  const count = groups.readUInt32LE(0);
  for (let i = 0; i < count; i++) {
    const offset = TOKEN_GROUPS_OFFSET + i * SID_AND_ATTRIBUTES_SIZE;
    const entry = koffi.decode(groups, offset, SID_AND_ATTRIBUTES) as { Sid: Handle; Attributes: number };
    const isLogon = ((entry.Attributes & SE_GROUP_LOGON_ID) >>> 0) === (SE_GROUP_LOGON_ID >>> 0);
    if (!entry.Sid || !isLogon) continue;
    const len = api.getLengthSid(entry.Sid);
    if (len === 0) throw lastError('GetLengthSid', `group ${i}`);
    const copy = Buffer.alloc(len);
    if (api.copySid(len, copy, entry.Sid) === 0) throw lastError('CopySid', `group ${i}`);
    return copy;
  }
  throw new Error('CreateRestrictedToken prerequisite failed: no logon SID');
}

export function makeWellKnownSid(type: number): Buffer {
  const sid = Buffer.alloc(SECURITY_MAX_SID_SIZE);
  const size: [number] = [SECURITY_MAX_SID_SIZE];
  if (api.createWellKnownSid(type, null, sid, size) === 0) {
    throw lastError('CreateWellKnownSid', `type ${type}`);
  }
  if (api.isValidSid(sid) === 0) throw lastError('IsValidSid', `type ${type}`);
  return sid;
}

function packSids(sids: Buffer[]): Buffer {
  const buf = Buffer.alloc(SID_AND_ATTRIBUTES_SIZE * sids.length);
  sids.forEach((sid, i) => {
    buf.writeBigUInt64LE(koffi.address(sid), SID_AND_ATTRIBUTES_SIZE * i);
  });
  return buf;
}

export function createRestrictedToken(
  current: Handle,
  logonSid: Buffer,
  writeSids: Buffer[],
  world: Buffer,
  mode: 'workspace' | 'read-only',
): Handle {
  const list = mode === 'read-only' ? [logonSid, world] : [logonSid, world, ...writeSids];
  if (mode === 'workspace' && writeSids.length === 0) {
    throw new Error('workspace sandbox requires write SIDs');
  }
  const packed = packSids(list);
  const slot: [Handle] = [null];
  const created = api.createRestrictedToken(
    current,
    DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED,
    0,
    null,
    0,
    null,
    list.length,
    packed,
    slot,
  );
  if (created === 0 || !slot[0]) throw lastError('CreateRestrictedToken');
  return slot[0];
}

export function setDefaultDaclGrant(token: Handle, sid: Buffer): void {
  const needed: [number] = [0];
  api.getTokenInformation(token, TokenDefaultDacl, null, 0, needed);
  if (needed[0] === 0) throw lastError('GetTokenInformation', 'TokenDefaultDacl size');
  const buffer = Buffer.alloc(needed[0]);
  if (api.getTokenInformation(token, TokenDefaultDacl, buffer, buffer.length, needed) === 0) {
    throw lastError('GetTokenInformation', 'TokenDefaultDacl');
  }
  const current = koffi.decode(buffer, 0, 'void *') as Handle;
  const newAcl: [Handle] = [null];
  const entry = explicitAccessEntry(sid, GRANT_ACCESS, FILE_ALL_ACCESS, SUB_CONTAINERS_AND_OBJECTS_INHERIT);
  const merged = api.setEntriesInAclW(1, entry, current, newAcl);
  if (merged !== 0 || !newAcl[0]) throw lastError('SetEntriesInAclW', 'default DACL');
  const info = Buffer.alloc(8);
  info.writeBigUInt64LE(koffi.address(newAcl[0]), 0);
  if (api.setTokenInformation(token, TokenDefaultDacl, info, info.length) === 0) {
    api.localFree(newAcl[0]);
    throw lastError('SetTokenInformation', 'TokenDefaultDacl');
  }
  api.localFree(newAcl[0]);
}
