/**
 * 程序嵌入面：别的进程可以 bootstrap + driver 跑一轮，不必进 TUI。
 * 不是 pi 那套 RPC 服务；只把已经存在的运行时接缝导出。
 */
export { runTurn } from './plugins/sph-loop/loop.js';
export type { AgentDriver, RunTurnOptions } from './agent/driver.js';
export { bootstrapRuntime, type Runtime } from './cli/bootstrap.js';
export { createClient, registerAdapter } from './plugins/sph-llm/index.js';
export { defaultTools, ToolRegistry } from './plugins/sph-tools/index.js';
export { jsonlSessionFactory, JsonlSession } from './plugins/sph-session/store.js';
export type { SessionPort, SessionFactory } from './session/types.js';
export type { SandboxHandle, SandboxFactory } from './sandbox/types.js';
