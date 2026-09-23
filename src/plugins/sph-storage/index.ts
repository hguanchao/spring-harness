/**
 * sph-storage：超长工具结果落盘。
 */
import type { PluginApi } from '../types.js';
import { STORAGE_SERVICE, type StorageService } from '../services.js';
import { SpillStore } from './spill.js';

const service: StorageService = {
  open: (dir, threshold) => new SpillStore(dir, threshold),
};

/** 插件入口。宿主按 `src/plugins/sph-storage/` 装载。 */
export default function setup(api: PluginApi): void {
  api.provide(STORAGE_SERVICE, service);
}
