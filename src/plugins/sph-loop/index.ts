/**
 * sph-loop：一轮对话的驱动。压缩、预算、工具批和子会话都在这里。
 *
 * 入口只登记服务。loop.ts 会拉压缩、权限、会话折叠和工具批，启动时还不需要；
 * setup 里踢一脚动态 import，和后续的会话锁 / MCP 重叠。
 */
import type { PluginApi } from '../types.js';
import { LOOP_SERVICE, type LoopService } from '../services.js';
import { WorktreeStore } from './worktrees.js';

const service: LoopService = {
  runTurn: (options) => import('./loop.js').then((mod) => mod.runTurn(options)),
  createWorktrees: () => new WorktreeStore(),
};

/**
 * 插件入口。宿主按 `src/plugins/sph-loop/` 装载。
 *
 * 导出成对象形态是为了挂 `description`：函数形态的默认导出没有地方写自述，
 * 而那句自述正是 `/plugins` 明细里的第一行。
 */
function setup(api: PluginApi): void {
  void import('./loop.js');
  api.provide(LOOP_SERVICE, service);
}

export default {
  description: 'Drives one turn: compaction, budgets, tool batches, sub-sessions.',
  setup,
};
