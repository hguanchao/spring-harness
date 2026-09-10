import koffi from 'koffi';

export const PROCESS_QUERY_INFORMATION = 0x0400;
export const TOKEN_ASSIGN_PRIMARY = 0x0001;
export const TOKEN_DUPLICATE = 0x0002;
export const TOKEN_QUERY = 0x0008;
export const TOKEN_ADJUST_DEFAULT = 0x0080;
export const SE_GROUP_LOGON_ID = 0xc0000000;
export const DISABLE_MAX_PRIVILEGE = 0x1;
export const LUA_TOKEN = 0x4;
export const WRITE_RESTRICTED = 0x8;
export const WinWorldSid = 1;
export const TokenGroups = 2;
export const TokenDefaultDacl = 6;
export const DACL_SECURITY_INFORMATION = 0x00000004;
export const SE_FILE_OBJECT = 1;
export const TRUSTEE_IS_SID = 0;
export const TRUSTEE_IS_UNKNOWN = 0;
export const NO_MULTIPLE_TRUSTEE = 0;
export const GRANT_ACCESS = 1;
export const REVOKE_ACCESS = 4;
export const SUB_CONTAINERS_AND_OBJECTS_INHERIT = 0x3;
export const ERROR_SUCCESS = 0;
export const FILE_GENERIC_WRITE = 0x00120116;
export const DELETE = 0x00010000;
export const FILE_DELETE_CHILD = 0x0040;
export const STANDARD_RIGHTS_WRITE = 0x00020000;
export const GRANT_MASK = (FILE_GENERIC_WRITE | DELETE | FILE_DELETE_CHILD) & ~STANDARD_RIGHTS_WRITE;
export const FILE_ALL_ACCESS = 0x1f01ff;
export const SID_AND_ATTRIBUTES_SIZE = 16;
export const TOKEN_GROUPS_OFFSET = 8;
export const EXPLICIT_ACCESS_W_SIZE = 48;
export const SECURITY_MAX_SID_SIZE = 68;
export const STARTF_USESTDHANDLES = 0x00000100;
export const HANDLE_FLAG_INHERIT = 1;

export type Handle = unknown;

const kernel32 = koffi.load('kernel32.dll');
const advapi32 = koffi.load('advapi32.dll');

const STARTUPINFOW = koffi.struct('SphSTARTUPINFOW', {
  cb: 'uint32',
  lpReserved: 'void *',
  lpDesktop: 'str16',
  lpTitle: 'void *',
  dwX: 'uint32',
  dwY: 'uint32',
  dwXSize: 'uint32',
  dwYSize: 'uint32',
  dwXCountChars: 'uint32',
  dwYCountChars: 'uint32',
  dwFillAttribute: 'uint32',
  dwFlags: 'uint32',
  wShowWindow: 'uint16',
  cbReserved2: 'uint16',
  lpReserved2: 'void *',
  hStdInput: 'void *',
  hStdOutput: 'void *',
  hStdError: 'void *',
});

const PROCESS_INFORMATION = koffi.struct('SphPROCESS_INFORMATION', {
  hProcess: 'void *',
  hThread: 'void *',
  dwProcessId: 'uint32',
  dwThreadId: 'uint32',
});

const SECURITY_ATTRIBUTES = koffi.struct('SphSECURITY_ATTRIBUTES', {
  nLength: 'uint32',
  lpSecurityDescriptor: 'void *',
  bInheritHandle: 'int32',
});

const SID_AND_ATTRIBUTES = koffi.struct('SphSID_AND_ATTRIBUTES', {
  Sid: 'void *',
  Attributes: 'uint32',
});

export const api = {
  getLastError: kernel32.func('uint32 __stdcall GetLastError()') as () => number,
  closeHandle: kernel32.func('int32 __stdcall CloseHandle(void *)') as (h: Handle) => number,
  openProcess: kernel32.func('void * __stdcall OpenProcess(uint32, int32, uint32)') as (
    access: number,
    inherit: number,
    pid: number,
  ) => Handle,
  waitForSingleObject: kernel32.func('uint32 __stdcall WaitForSingleObject(void *, uint32)') as (
    h: Handle,
    ms: number,
  ) => number,
  getExitCodeProcess: kernel32.func('int32 __stdcall GetExitCodeProcess(void *, _Out_ uint32 *)') as (
    h: Handle,
    code: [number],
  ) => number,
  terminateProcess: kernel32.func('int32 __stdcall TerminateProcess(void *, uint32)') as (
    h: Handle,
    code: number,
  ) => number,
  createPipe: kernel32.func('int32 __stdcall CreatePipe(_Out_ void **, _Out_ void **, SphSECURITY_ATTRIBUTES *, uint32)') as (
    read: [Handle],
    write: [Handle],
    sa: unknown,
    size: number,
  ) => number,
  setHandleInformation: kernel32.func('int32 __stdcall SetHandleInformation(void *, uint32, uint32)') as (
    h: Handle,
    mask: number,
    flags: number,
  ) => number,
  readFile: kernel32.func('int32 __stdcall ReadFile(void *, void *, uint32, _Out_ uint32 *, void *)') as (
    h: Handle,
    buf: Buffer,
    n: number,
    read: [number],
    overlapped: Handle | null,
  ) => number,
  peekNamedPipe: kernel32.func('int32 __stdcall PeekNamedPipe(void *, void *, uint32, void *, _Out_ uint32 *, void *)') as (
    h: Handle,
    buf: Handle | null,
    n: number,
    read: Handle | null,
    avail: [number],
    left: Handle | null,
  ) => number,
  localFree: kernel32.func('void * __stdcall LocalFree(void *)') as (p: Handle) => Handle,

  openProcessToken: advapi32.func('int32 __stdcall OpenProcessToken(void *, uint32, _Out_ void **)') as (
    process: Handle,
    access: number,
    token: [Handle],
  ) => number,
  getTokenInformation: advapi32.func('int32 __stdcall GetTokenInformation(void *, uint32, void *, uint32, _Out_ uint32 *)') as (
    token: Handle,
    cls: number,
    info: Buffer | null,
    len: number,
    needed: [number],
  ) => number,
  setTokenInformation: advapi32.func('int32 __stdcall SetTokenInformation(void *, uint32, void *, uint32)') as (
    token: Handle,
    cls: number,
    info: Buffer,
    len: number,
  ) => number,
  createWellKnownSid: advapi32.func('int32 __stdcall CreateWellKnownSid(uint32, void *, void *, _Inout_ uint32 *)') as (
    type: number,
    domain: Handle | null,
    sid: Buffer,
    size: [number],
  ) => number,
  isValidSid: advapi32.func('int32 __stdcall IsValidSid(void *)') as (sid: Buffer | Handle) => number,
  getLengthSid: advapi32.func('uint32 __stdcall GetLengthSid(void *)') as (sid: Handle) => number,
  copySid: advapi32.func('int32 __stdcall CopySid(uint32, void *, void *)') as (
    len: number,
    dest: Buffer,
    src: Handle,
  ) => number,
  convertStringSidToSidW: advapi32.func('int32 __stdcall ConvertStringSidToSidW(str16, _Out_ void **)') as (
    sid: string,
    out: [Handle],
  ) => number,
  createRestrictedToken: advapi32.func(
    'int32 __stdcall CreateRestrictedToken(void *, uint32, uint32, void *, uint32, void *, uint32, void *, _Out_ void **)',
  ) as (
    existing: Handle,
    flags: number,
    disableCount: number,
    disable: Handle | null,
    deleteCount: number,
    deleted: Handle | null,
    restrictCount: number,
    restrict: Buffer,
    out: [Handle],
  ) => number,
  getNamedSecurityInfoW: advapi32.func(
    'uint32 __stdcall GetNamedSecurityInfoW(str16, uint32, uint32, void *, void *, _Out_ void **, void *, _Out_ void **)',
  ) as (
    path: string,
    type: number,
    info: number,
    owner: Handle | null,
    group: Handle | null,
    dacl: [Handle],
    sacl: Handle | null,
    sd: [Handle],
  ) => number,
  setNamedSecurityInfoW: advapi32.func(
    'uint32 __stdcall SetNamedSecurityInfoW(str16, uint32, uint32, void *, void *, void *, void *)',
  ) as (
    path: string,
    type: number,
    info: number,
    owner: Handle | null,
    group: Handle | null,
    dacl: Handle | null,
    sacl: Handle | null,
  ) => number,
  setEntriesInAclW: advapi32.func('uint32 __stdcall SetEntriesInAclW(uint32, void *, void *, _Out_ void **)') as (
    count: number,
    entries: Buffer,
    oldAcl: Handle | null,
    newAcl: [Handle],
  ) => number,
  createProcessAsUserW: advapi32.func(
    'int32 __stdcall CreateProcessAsUserW(void *, void *, void *, void *, void *, int32, uint32, void *, str16, SphSTARTUPINFOW *, SphPROCESS_INFORMATION *)',
  ) as (
    token: Handle,
    app: Handle | null,
    cmd: Buffer,
    procSa: Handle | null,
    threadSa: Handle | null,
    inherit: number,
    flags: number,
    env: Handle | null,
    cwd: string,
    startup: unknown,
    pi: unknown,
  ) => number,
};

export { STARTUPINFOW, PROCESS_INFORMATION, SECURITY_ATTRIBUTES, SID_AND_ATTRIBUTES };

export function lastError(name: string, detail?: string): Error {
  return new Error(`${name} failed (${api.getLastError()})${detail ? `: ${detail}` : ''}`);
}

export function win32Error(name: string, code: number, detail?: string): Error {
  return new Error(`${name} failed (${code})${detail ? `: ${detail}` : ''}`);
}

export function inheritSa(): unknown {
  return {
    nLength: koffi.sizeof(SECURITY_ATTRIBUTES),
    lpSecurityDescriptor: null,
    bInheritHandle: 1,
  };
}

export function emptyStartup(stdin: Handle | null, stdout: Handle, stderr: Handle): unknown {
  return {
    cb: koffi.sizeof(STARTUPINFOW),
    lpReserved: null,
    lpDesktop: null,
    lpTitle: null,
    dwX: 0,
    dwY: 0,
    dwXSize: 0,
    dwYSize: 0,
    dwXCountChars: 0,
    dwYCountChars: 0,
    dwFillAttribute: 0,
    dwFlags: STARTF_USESTDHANDLES,
    wShowWindow: 0,
    cbReserved2: 0,
    lpReserved2: null,
    hStdInput: stdin,
    hStdOutput: stdout,
    hStdError: stderr,
  };
}

/**
 * 构造 EXPLICIT_ACCESS_W（48 字节）。
 *
 * 文件 ACL 授权（acl.ts）与令牌默认 DACL（token.ts）原本各手写一份相同的内存布局，
 * 偏移量一改就得同时改两处且编译器不会提醒；这里收敛成唯一实现。
 * 未显式写入的字节保持 0，即 MultipleTrusteeOperation = NO_MULTIPLE_TRUSTEE(0)、
 * TrusteeType = TRUSTEE_IS_UNKNOWN(0)，与 Windows 期望的默认值一致。
 *
 * @param trustee SID 句柄（可为 koffi 句柄或 Buffer，两者都按指针取地址）。
 */
export function explicitAccessEntry(
  trustee: unknown,
  mode: number,
  permissions: number,
  inheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT,
): Buffer {
  const entry = Buffer.alloc(EXPLICIT_ACCESS_W_SIZE);
  entry.writeUInt32LE(permissions >>> 0, 0);
  entry.writeUInt32LE(mode, 4);
  entry.writeUInt32LE(inheritance, 8);
  entry.writeUInt32LE(TRUSTEE_IS_SID, 28);
  entry.writeBigUInt64LE(koffi.address(trustee), 40);
  return entry;
}
