/**
 * 程序嵌入面：别的进程可以 bootstrap + driver 跑一轮，不必进 TUI。
 * 只把已经存在的运行时接缝导出，不另开一套远程服务。
 *
 * 第一行是坑：bootstrap 之后插件按需装载，而 sph-tui 是编译进 `dist/plugins/` 的，
 * 它的 import 用的是 `@/...`。宿主跑产物时没有这层解析器，必须在这里先挂上。
 * 放在最前是必须的 —— ESM 按 import 顺序求值，静态依赖图跑在模块体之前。
 */

import './cli/alias-resolver.js';

export { runTurn } from './plugins/sph-loop/loop.js';
export type { AgentDriver, RunTurnOptions } from './agent/driver.js';
export { bootstrapRuntime, type Runtime } from './cli/bootstrap.js';
export { createClient, registerAdapter } from './plugins/sph-llm/index.js';
export { defaultTools, ToolRegistry } from './plugins/sph-tools/index.js';
export { jsonlSessionFactory, JsonlSession } from './plugins/sph-session/store.js';
export type { SessionPort, SessionFactory } from './session/types.js';
export type { SandboxHandle, SandboxFactory } from './sandbox/types.js';
