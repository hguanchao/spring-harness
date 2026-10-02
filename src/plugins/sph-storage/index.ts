/**
 * sph-storage：超长工具结果落盘。
 */
import type { PluginApi } from '../types.js';
import { STORAGE_SERVICE, type StorageService } from '../services.js';
import { SpillStore } from './spill.js';

const service: StorageService = {
  open: (dir, threshold) => new SpillStore(dir, threshold),
};

/**
 * 插件入口。宿主按 `src/plugins/sph-storage/` 装载。
 *
 * 导出成对象形态是为了挂 `description`：函数形态的默认导出没有地方写自述，
 * 而那句自述正是 `/plugins` 明细里的第一行。
 */
function setup(api: PluginApi): void {
  api.provide(STORAGE_SERVICE, service);
}

export default {
  description: 'Spills oversized tool results to disk.',
  setup,
};
