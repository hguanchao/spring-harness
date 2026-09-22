/**
 * plan mode 插件入口。
 *
 * 一个插件同时做两件事：注册 `enter_plan_mode` / `exit_plan_mode` 两个工具，
 * 并提供 `PlanModeSeam` 服务——核心的 loop 拦截点与提示词引导都经这个服务拿行为。
 * 这就是「插件声明策略、核心执行策略」的落点：拦哪些工具、引导词是什么，都在本目录；
 * 拒绝调用发生在哪里，由核心决定。
 */

import type { PluginApi } from '../types.js';
import { registerPlanTools } from './tool.js';
import setupCore from './plan-core.js';

/** 插件入口。宿主按 `src/plugins/plan/` 装载，插件名取目录名。 */
export default function setup(api: PluginApi): void {
  // plan-core 的默认导出提供 PlanModeSeam 服务；tool.ts 注册两个工具。
  setupCore(api);
  registerPlanTools(api);
}
