/**
 * plan mode 插件入口。
 *
 * 一个插件同时做两件事：注册 `enter_plan_mode` / `exit_plan_mode` 两个工具，
 * 并提供 `PlanModeSeam` 服务——核心的 loop 拦截点与提示词引导都经这个服务拿行为。
 * 这就是「插件声明例外、核心执行策略」的落点：只读子代理放不放行、引导词是什么，
 * 都在本目录；默认按 planSafe 拦截，拒绝发生在 loop 里。
 */

import type { PluginApi } from '../types.js';
import { registerPlanCommand } from './command.js';
import { registerPlanTools } from './tool.js';
import setupCore from './plan-core.js';

/** 插件入口。宿主按 `src/plugins/sph-plan/` 装载，插件名取目录名。 */
export default function setup(api: PluginApi): void {
  // plan-core 的默认导出提供 PlanModeSeam 服务；tool.ts 注册两个工具。
  setupCore(api);
  registerPlanTools(api);
  registerPlanCommand(api);
}
