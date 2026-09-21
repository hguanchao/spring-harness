import {
  api,
  DISABLE_MAX_PRIVILEGE,
  LUA_TOKEN,
  PROCESS_QUERY_INFORMATION,
  TOKEN_ADJUST_DEFAULT,
  TOKEN_ASSIGN_PRIMARY,
  TOKEN_DUPLICATE,
  TOKEN_QUERY,
  lastError,
  type Handle,
} from './win32.js';

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

/**
 * 过滤令牌：只剥特权、把管理组降为「仅拒绝」成员（LUA），不挂受限 SID 列表。
 *
 * 不用受限列表做文件系统围栏的原因：msys/cygwin 运行时初始化要创建只授予「用户 SID」
 * 的共享节与信号管道，写受限（WRITE_RESTRICTED）检查会把这步拒掉，真 Git Bash 活不过
 * 启动（couldn't create signal pipe / CreateFileMapping, error 5）。实测 LUA + 剥特权
 * 两者单独或组合都不影响 msys bash；写入边界改由工具层沙箱策略与审批兜底。
 */
export function createFilteredToken(current: Handle): Handle {
  const slot: [Handle] = [null];
  const created = api.createRestrictedToken(
    current,
    DISABLE_MAX_PRIVILEGE | LUA_TOKEN,
    0,
    null,
    0,
    null,
    0,
    Buffer.alloc(0),
    slot,
  );
  if (created === 0 || !slot[0]) throw lastError('CreateRestrictedToken');
  return slot[0];
}

