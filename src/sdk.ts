/**
 * 程序嵌入面：别的进程可以 bootstrap + driver 跑一轮，不必进 TUI。
 * 不是 pi 那套 RPC 服务；只把已经存在的运行时接缝导出。
 */
export { runTurn, type AgentDriver, type RunTurnOptions } from './agent/loop.js';
export { bootstrapRuntime, createClient, registerAdapter, type Runtime } from './cli/bootstrap.js';
export { defaultTools, ToolRegistry } from './tools/index.js';
export { jsonlSessionFactory, JsonlSession } from './session/store.js';
export type { SessionPort, SessionFactory } from './session/types.js';
export type { SandboxHandle, SandboxFactory } from './sandbox/types.js';
