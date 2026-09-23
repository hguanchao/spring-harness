/**
 * sph-loop：一轮对话的驱动。压缩、预算、工具批和子会话都在这里。
 */
import type { PluginApi } from '../types.js';
import { LOOP_SERVICE, type LoopService } from '../services.js';
import { runTurn } from './loop.js';
import { WorktreeStore } from './worktrees.js';

const service: LoopService = {
  runTurn,
  createWorktrees: () => new WorktreeStore(),
};

/** 插件入口。宿主按 `src/plugins/sph-loop/` 装载。 */
export default function setup(api: PluginApi): void {
  api.provide(LOOP_SERVICE, service);
}
