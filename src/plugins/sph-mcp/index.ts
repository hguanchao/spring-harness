/**
 * sph-mcp：把 MCP 以插件形式接回 sph。
 *
 * 这个插件承担三件事，也是插件的三种典型能力：
 *
 * 1. **注册工具** —— 模型可调用的 `mcp` 工具（`./tool.ts`）。
 * 2. **提供服务** —— 服务名 `sph-mcp`，宿主界面（`/mcps` 弹窗、上报文本）与其它插件
 *    都按这个名字取用。核心只认接缝类型（`src/plugins/services.ts`），不认实现。
 * 3. **登记清理** —— 退出时关掉所有 MCP 子进程，否则每个 server 都会变成孤儿进程。
 *
 * ## 发现与装载都在这里
 *
 * 过去 `bootstrap` 调 `discoverMcpServers()` 再喂给 `McpHub.reload()`；现在两者都归本插件，
 * 核心只调 `service.reload({ workspaceRoot, fromDir, preferences, trusted })`。核心交出的
 * 是**宿主事实**（工作区、启停偏好、信任态），插件交出的是**MCP 领域逻辑**——这条分界线
 * 正是「MCP 是个插件」的含义：核心代码里搜不到 MCP 的来源清单与优先级规则。
 *
 * ## 装载失败不炸启动
 *
 * `reload()` 与 `McpHub` 一样不抛错：坏配置、命令不存在、握手超时统统降级成警告与
 * `problems`，经 `warnings()` / `listServers()` 露出。启动阶段为了一个配错的 server
 * 而崩掉，等于让最不重要的那件事决定整个会话能不能开始。
 */

import type { PluginApi } from '../types.js';
import {
  MCP_SERVICE,
  type McpPreferences,
  type McpReloadOptions,
  type McpReloadResult,
  type McpServerStatus,
  type McpSourceReport,
  type McpTool,
} from '../services.js';
import { McpHub } from './hub.js';
import { discoverMcpServers } from './sources.js';
import { createMcpTool } from './tool.js';

const EMPTY_PREFERENCES: McpPreferences = {
  disabledServers: [],
  enabledServers: [],
  lazyServers: [],
};

/**
 * 把 hub 与发现包成宿主认识的服务，并在插件内部持有两份状态：
 *
 * - `reports`：最近一次发现里各候选文件的读取结果。
 * - `warnings`：最近一次刷新以来的问题，含 spawn 后的**异步**握手失败。
 *
 * 异步失败必须能被看见：`spawn` 不等握手，所以「server 没起来」在 `reload()` 返回时
 * 还不知道，只能由 `onProblem` 回调补进警告里，否则用户看到的是一次「成功」的刷新。
 */
class McpPluginService {
  private readonly hub: McpHub;
  private readonly hostFacts: PluginApi['host'];
  private reports: readonly McpSourceReport[] = [];
  private problemLog: string[] = [];

  constructor(hub: McpHub, hostFacts: PluginApi['host']) {
    this.hub = hub;
    this.hostFacts = hostFacts;
    this.hub.onProblem = (message: string): void => {
      if (!this.problemLog.includes(message)) this.problemLog.push(message);
    };
  }

  async reload(options: McpReloadOptions): Promise<McpReloadResult> {
    const discovery = discoverMcpServers({
      workspaceRoot: options.workspaceRoot,
      host: this.hostFacts,
      fromDir: options.fromDir,
      preferences: options.preferences ?? EMPTY_PREFERENCES,
      trusted: options.trusted,
    });
    this.reports = discovery.reports;
    const result = await this.hub.reload(discovery.servers);
    // 顺序即因果：先有来源读取的问题，再有装载的问题。握手失败由 onProblem 追加在最后。
    this.problemLog = [...discovery.warnings, ...result.warnings];
    return result;
  }

  sources(): readonly McpSourceReport[] {
    return this.reports;
  }

  warnings(): readonly string[] {
    return this.problemLog;
  }

  listTools(): McpTool[] {
    return this.hub.listTools();
  }

  listServers(): McpServerStatus[] {
    return this.hub.listServers();
  }

  listToolsOf(server: string): Promise<McpTool[]> {
    return this.hub.listToolsOf(server);
  }

  call(server: string, name: string, args: Record<string, unknown>): Promise<string> {
    return this.hub.call(server, name, args);
  }

  whenReady(timeoutMs?: number): Promise<void> {
    return this.hub.whenReady(timeoutMs);
  }

  dispose(): void {
    this.hub.dispose();
  }
}

/** 插件入口。宿主按 `plugins/sph-mcp/` 目录装载，插件名取目录名。 */
export default function setup(api: PluginApi): void {
  const hub = new McpHub(api.host);
  const service = new McpPluginService(hub, api.host);

  api.registerTool(createMcpTool(api, hub));
  api.provide(MCP_SERVICE, service);
  api.onDispose(() => {
    service.dispose();
  });
}
