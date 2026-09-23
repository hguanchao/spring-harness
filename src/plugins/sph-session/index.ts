/**
 * sph-session：JSONL 会话、锁、折叠与导出。
 */
import type { PluginApi } from '../types.js';
import { SESSION_SERVICE, type SessionService } from '../services.js';
import { exportHtml, exportJson, exportMarkdown } from './export.js';
import { foldSessionState } from './fold.js';
import { acquireSessionLock, hasOtherLiveSessionIn, SessionLockedError } from './lock.js';
import { sessionDirFor } from './path.js';
import { jsonlSessionFactory, listSessions, setCurrentSession } from './store.js';

/** 内置实现。界面在宿主没注入服务时用它，测试不必先装一遍插件。 */
export const sessionService: SessionService = {
  sessionDirFor,
  resumeOrCreate: (dir, workspaceRoot, forceNew) => jsonlSessionFactory.resumeOrCreate(dir, workspaceRoot, forceNew),
  open: (dir, id) => jsonlSessionFactory.open(dir, id),
  activate: setCurrentSession,
  acquireLock: acquireSessionLock,
  isLockError: (error) => error instanceof SessionLockedError,
  hasOtherLiveSession: (workspaceRoot) => hasOtherLiveSessionIn(sessionDirFor(workspaceRoot)),
  factory: jsonlSessionFactory,
  list: (dir, options) => listSessions(dir, options),
  fold: (records) => foldSessionState(records),
  exportMarkdown,
  exportJson,
  exportHtml,
};

/** 插件入口。宿主按 `src/plugins/sph-session/` 装载。 */
export default function setup(api: PluginApi): void {
  api.provide(SESSION_SERVICE, sessionService);
}
