/**
 * 交互模式的依赖注入面。
 *
 * CLI 装配（bootstrap）负责把真实实现接进来，测试注入假实现驱动整条链路。
 * 单独成文件：按域拆出的命令模块（*-commands.ts）与交互模式都要引用它，
 * 放在装配文件里会制造循环 import。
 */

import type { AgentDriver } from '../agent/loop.js';
import type { ApiProtocol } from '../config/load.js';
import type { ProviderDeclaration, ResolvedModel } from '../config/registry.js';
import type { LlmClient, ReasoningEffort } from '../llm/openai.js';
import type { McpReloadResult, McpPreferences, McpService } from '../plugins/services.js';
import type { LoadedPlugin } from '../plugins/host.js';
import type { PluginLoadFailure } from '../plugins/loader.js';
import type { PluginServices } from '../plugins/types.js';
import type { ApprovalMode, PermissionRules, SubagentApprovalPolicy } from '../permission/policy.js';
import type { JobBoard } from '../runtime/jobs.js';
import type { TodoService } from '../plugins/services.js';
import type { WorktreeStore } from '../runtime/worktrees.js';
import type { SandboxHandle } from '../sandbox/types.js';
import type { JsonlSession } from '../session/store.js';
import type { SessionFactory } from '../session/types.js';
import type { ToolRegistry } from '../tools/index.js';
import type { Terminal, TUI } from './screen/index.js';

export interface TuiDeps {
  workspaceRoot: string;
  sessionDir: string;
  /** config.toml 路径：/model、/effort、/permission 的选择写回这里，下次启动仍生效。 */
  configPath: string;
  /** 欢迎态底部右对齐的登录状态文案（API key / 免鉴权头）。 */
  authLabel: string;
  /** config.toml 里生效的 provider 名（models.json 的声明之一）。 */
  providerName: string;
  /** models.json 的 provider 声明；/model 列表从这里来（不再拉上游）。 */
  models(): readonly ProviderDeclaration[];
  /** 按模型 id（可指定 provider）解析生效协议与容量声明。 */
  resolveModel(model: string, provider?: string): ResolvedModel;
  contextWindow: number;
  maxTokens?: number;
  sandbox: SandboxHandle;
  session: JsonlSession;
  /**
   * 取 `sph-mcp` 插件提供的服务。
   *
   * 是方法而不是字段：服务在插件装载后才存在，且**可能永远不存在**（插件被
   * `[plugins] disabled` 关掉，或加载失败）。用方法表达「每次都要重新确认它在不在」，
   * 界面据此如实显示「MCP 插件没装」，而不是对着一份空清单猜。
   */
  mcp(): McpService | undefined;
  /**
   * 重新发现并装载 MCP server（`/mcps` 里按 r、改完启停、或导入之后调用）。
   *
   * 必需：启动时的首次装载与这里的刷新走的是同一条装配路径，缺了它就只能重启——
   * 而「改完配置要重启」正是这轮要消掉的那件事。
   */
  reloadMcp(): Promise<McpReloadResult>;
  /** 重新读 `[mcp]` 偏好段；写回 config.toml 之后调用。 */
  refreshMcpPreferences(): void;
  /** 生效中的 MCP 启停偏好，供弹窗显示当前状态。 */
  mcpPreferences: McpPreferences;
  /** 已装载插件与导入失败的摘要，供 `/plugins` 与诊断显示。 */
  pluginReport(): { plugins: LoadedPlugin[]; failures: PluginLoadFailure[]; shadowed: string[]; pinned?: string[] };
  /** 插件服务表；loop 按接缝名取用（sph-mcp 的清单进提示词），插件工具也靠它取兄弟服务。 */
  pluginServices: PluginServices;
  /** todo 服务（todo 插件提供）。 */
  todos: TodoService;
  jobs: JobBoard;
  approvalMode: ApprovalMode;
  /** `[permissions]` 规则；省略即无规则。 */
  permissionRules?: PermissionRules;
  /** 子代理审批策略；省略按 inherit。 */
  subagentApproval?: SubagentApprovalPolicy;
  model: string;
  effort?: ReasoningEffort;
  /** /model 与 /effort 改动后按新参数重建 client；api 省略时由 provider 声明按模型解析。 */
  makeClient(options: { model: string; provider?: string; api?: ApiProtocol; effort?: ReasoningEffort; maxTokens?: number }): LlmClient;
  /**
   * 辅助调用（压缩摘要 / auto 审查器）的 client；模型名省略时返回 undefined。
   *
   * 必需而非可选：此前这条线没接上，配置了 `compact_model` / `review_model` 也一直用主模型，
   * 是个静默失效的省钱开关。做成必需，调用方漏接就编译不过。
   */
  makeAuxClient(model: string | undefined): LlmClient | undefined;
  /** CLI 显式给了 --model：启动时不被会话里记录的模型覆盖。 */
  modelPinned?: boolean;
  /** 压缩摘要 / auto 审批审查器专用模型；省略都回退主模型。 */
  compactModel?: string;
  reviewModel?: string;
  /** spill 落盘根目录。 */
  spillRoot?: string;
  spillThreshold?: number;
  /** 子代理嵌套深度预算（config.subagent_max_depth）；省略用内置默认 1（扁平）。 */
  maxSubagentDepth?: number;
  /** 会话累计 token 预算（config.max_session_tokens）；省略或 0 = 不限制。 */
  maxSessionTokens?: number;
  /** 子代理 worktree 隔离的工作树仓库（isolation: worktree 用）。 */
  worktrees?: WorktreeStore;
  /** 把会话锁换到另一个 id；失败时抛错，当前会话仍占用。 */
  claimSession?(id: string): void;
  /** 可注入工具表 / 会话工厂 / 驱动；省略走产品默认。 */
  tools?: ToolRegistry;
  sessions?: SessionFactory;
  driver?: AgentDriver;
  /** 注入终端实现；省略用 ProcessTerminal（测试用假终端驱动整条链路）。 */
  terminal?: Terminal;
  /**
   * 已经 start 过的 TUI。信任页会先占用同一块替代屏幕，主界面接手后不得再 start。
   * 省略则本模块自己创建并 start。
   */
  ui?: TUI;
  /** MCP 启动警告；在 TUI 里用通知展示，避免写 stderr 打穿替代屏幕。 */
  mcpWarnings?: readonly string[];
}
