/**
 * sph-sandbox：把 OS 隔离引擎做成内置插件。
 *
 * 核心保留档位、fail-closed 和 read-only 写拒绝；本插件只提供后端工厂。
 * confine 档位下插件缺席，核心拒绝启动，而不是放开约束。
 *
 * 名字钉死在装载器里：工作区或用户目录里的同名插件不能换掉这份后端。
 * 隔离被静默替换，等于把安全边界交给仓库里的任意代码。
 */
import { SANDBOX_SERVICE } from '../services.js';
import type { PluginApi } from '../types.js';
import { createSandboxBackend } from './backend.js';

/** 插件入口。宿主按 `src/plugins/sph-sandbox/` 装载，插件名取目录名。 */
export default function setup(api: PluginApi): void {
  api.provide(SANDBOX_SERVICE, createSandboxBackend);
}
