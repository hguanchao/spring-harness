/**
 * `sph-mcp` 插件对外暴露的服务契约（MCP seam）。
 *
 * 这里只有**接缝**：数据形状 + 一个接口，没有一行 MCP 实现。实现在 `plugins/sph-mcp/`，
 * 经插件系统装载后以服务名 `sph-mcp` 暴露给宿主界面与其它插件。
 *
 * 为什么 core 还要留着这些类型：宿主界面（`/mcps` 弹窗、上报文本）与核心配置解析
 * （`[[mcp_servers]]`、`[mcp]`）都要说这套数据结构。让它们 import 插件实现就等于把
 * MCP 重新焊回核心——插件被禁用时那些模块连编译都过不去。dsh 用的是同一套切法：
 * 能力接缝留在核心，实现由插件提供（`@deepseek-ai/dsh-mcp-client` 之于 `ctx.mcp`）。
 */

/** `[[mcp_servers]]` 的一条声明。 */
export interface McpServerConfig {
  name: string;
  /** stdio 启动命令。与 `url` 二选一；都没有的条目无效。 */
  command?: string;
  args?: string[];
  /** 追加到子进程环境之上。来源文件（Claude / Codex）里的 env 表直接落到这里。 */
  env?: Record<string, string>;
  /**
   * 远程端点（streamable HTTP）。sph 目前只实现 stdio。
   *
   * 带 url 的条目**必须能被发现并如实上报**，而不是在读取时静默丢掉——Claude / Codex 配置里
   * HTTP server 很常见，「我明明配了却不生效」是必须能看见原因的一类问题。
   */
  url?: string;
}

/** 一个定义的出处：展示标签 + 可否就地改写。 */
export interface McpOrigin {
  /** 展示标签，如 `~/.claude.json`、`.sph/config.toml`、`[mcp] disabled_servers`。 */
  label: string;
  /** 定义所在的文件路径；本地偏好来源指向 sph 用户配置。 */
  path: string;
  /**
   * sph 是否可以直接改写这个文件。
   *
   * 外部工具的文件（Claude / Codex / `.mcp.json`）一律 false：写入别人的配置会带来
   * 意料之外的副作用，启停改为在 sph 自己配置里存一份本地偏好。
   */
  editable: boolean;
}

/** `reload()` 的输入。两个字段都可省，省略时取默认值，便于测试与内部构造。 */
export interface McpServerSpec extends McpServerConfig {
  /** 省略即启用。 */
  enabled?: boolean;
  /**
   * 来源声明的启用态（叠加本地偏好之前）。
   *
   * 弹窗切换开关时要靠它判断该写哪个偏好列表：只留最终值就只能猜，猜错会在另一个列表里
   * 留下一条过期的强制项，日后来源改了自己的默认值就会被它悄悄盖住。
   */
  sourceEnabled?: boolean;
  /** true = 不随 reload 拉起，首次 call / list(server) 才连接。省略即立即连。 */
  lazy?: boolean;
  /** 省略时用中性标签。 */
  origin?: McpOrigin;
}

export interface McpTool {
  server: string;
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

/** 一个 server 的现状，供 `/mcps` 之类的展示用。 */
export interface McpServerStatus {
  name: string;
  transport: 'stdio' | 'http';
  /** false = sph 跑不了这个传输，或定义本身无效。 */
  supported: boolean;
  enabled: boolean;
  /** 来源声明的启用态；`enabled` 与它不同就说明本地偏好正在覆盖来源。 */
  sourceEnabled?: boolean;
  /** 首次使用才连接；与「连不上」区别在 problem——懒而未连的没有 problem。 */
  lazy: boolean;
  /** 子进程还活着。崩溃、从未连上、被禁用、不支持的传输都是 false。 */
  connected: boolean;
  /** 握手还在后台进行。启动不为此阻塞——这也是它存在的意义。 */
  connecting?: boolean;
  /** 启动命令行（stdio）或 URL（http）；连不上时用户最需要看到的就是它。 */
  target: string;
  /** 启用却没能工作时的原因；正常时 undefined。 */
  problem?: string;
  origin: McpOrigin;
  tools: McpTool[];
}

export interface McpReloadResult {
  /**
   * 同步就能确定的警告（配置无效、被禁用等）。**异步握手失败不在这里**——spawn 不等
   * 握手，失败走 `problems`（`listServers()` 可见）并由服务累计进 `warnings()`。
   */
  warnings: string[];
  added: string[];
  removed: string[];
  /** 命令签名变了、被重新拉起的（复用连接不算）。 */
  restarted: string[];
}

/**
 * 某个候选文件被读取的结果。
 *
 * 只为「我明明配了却看不到」服务：没读到也要说清是文件不存在、被导入标记跳过、还是
 * 解析失败——否则用户唯一能做的就是猜。
 */
export interface McpSourceReport {
  label: string;
  path: string;
  status: 'found' | 'empty' | 'missing' | 'skipped' | 'invalid';
  count: number;
  detail?: string;
}

/** 本地启停偏好：写在 sph 用户级配置的 `[mcp]` 段里，叠加在来源的 enabled 之上。 */
export interface McpPreferences {
  disabledServers: string[];
  enabledServers: string[];
  /** 首次使用才连接的 server（如重型的 npx server）；对任意来源生效，默认全部立即连。 */
  lazyServers: string[];
}

/** `reload()` 的输入：发现要用的工作区信息，加上由核心交过来的启停偏好。 */
export interface McpReloadOptions {
  workspaceRoot: string;
  /** 项目级查找的起点，向上走到 `workspaceRoot`（含）。省略即从 `workspaceRoot` 开始。 */
  fromDir?: string;
  /** 本地启停偏好，取自 sph 用户级配置。 */
  preferences?: McpPreferences;
  /** 工作区是否已信任；false 时项目级来源一律丢弃。省略则查 trusted.json。 */
  trusted?: boolean;
}

/**
 * `sph-mcp` 服务。
 *
 * 方法名与语义同此前的 McpHub（`reload` 是唯一装载入口，热重载与冷启动走同一条路径），
 * 只是入参换成了 `McpReloadOptions`——发现逻辑已随实现搬进插件，核心不再知道有哪几个来源。
 * 新增的是 `sources()` / `warnings()`：这两份状态过去由 bootstrap 分别持有，现在归插件，
 * 因为它们是**发现的产物**，而发现已经是插件的事。
 */
export interface McpService {
  /** 从所有来源重新发现并装载；热重载与首次启动共用这一条路径。 */
  reload(options: McpReloadOptions): Promise<McpReloadResult>;
  /** 最近一次发现里各候选来源文件的读取结果。 */
  sources(): readonly McpSourceReport[];
  /** 最近一次刷新以来累计的问题（配置无效、被禁用、异步握手失败）。 */
  warnings(): readonly string[];
  listTools(): McpTool[];
  listServers(): McpServerStatus[];
  listToolsOf(server: string): Promise<McpTool[]>;
  call(server: string, name: string, args: Record<string, unknown>): Promise<string>;
  whenReady(timeoutMs?: number): Promise<void>;
  dispose(): void;
}

/** 该服务的注册名。插件与宿主都引这里，避免两处各写一个字符串。 */
export const MCP_SERVICE = 'sph-mcp';

// ---------------------------------------------------------------------------
// todo 接缝
//
// 核心只保留类型，不引用 todo 插件的实现。折叠、TUI、runTurn 需要的是「清单长什么样、
// 事件长什么样」，不是「清单怎么被模型修改」。

/** 一条待办。 */
export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** `todo` 会话事件的数据形状：整表快照（last-wins）。 */
export interface TodoEventData {
  items: TodoItem[];
}

/** `todo` 服务：会话内清单的读写。实现由 todo 插件提供。 */
export interface TodoService {
  replace(items: TodoItem[]): TodoItem[];
  list(): TodoItem[];
}

/** `todo` 服务的注册名。插件与核心都引这里，避免两处各写一个字符串。 */
export const TODO_SERVICE = 'todo';

/** todo 服务缺席时的默认值：空清单、可安全调用。 */
export const EMPTY_TODO: TodoService = {
  replace: (items) => items.map((item) => ({ ...item })),
  list: () => [],
};

/**
 * `todo` 事件的序列化：整表快照。
 *
 * 放在接缝而不是 todo 插件里，是因为**写入方是核心**（loop 检测到清单变化后
 * appendEvent），而核心不能 import 插件实现。纯数据形状函数不携带任何插件逻辑。
 */
export function todoEventData(items: readonly TodoItem[]): TodoEventData {
  return { items: items.map((item) => ({ ...item })) };
}

// ---------------------------------------------------------------------------
// plan mode 接缝
//
// plan mode 是「策略」而非「数据」：它拦截副作用工具、注入引导正文、走用户审批。
// 核心保留 loop 的**执行点**（拒绝调用发生在 runTurn 里），但「拦哪些工具、引导词
// 是什么、计划长什么样」都由 plan 插件声明——否则核心又要按名字猜插件工具。
//
// 分界线的检验：`[plugins] disabled = ["plan"]` 时，核心不引用 plan 插件的实现，
// 但 loop 的拦截点仍在（它面对的是**空拦截表**——没有工具被拦，plan mode 也就
// 无法被进入，因为 enter_plan_mode 工具本身不在工具表里）。

/** 一个工具在 plan mode 下是否应被拦截。按能力声明，不按名字猜。 */
export type PlanBlockedPredicate = (toolName: string, args: Record<string, unknown>) => boolean;

/** plan mode 的宿主能力面：核心把执行点交给插件声明，插件把行为交给核心执行。 */
export interface PlanModeSeam {
  /** 是否拦截这个工具调用。explore 子代理等豁免在此判定。 */
  isBlocked(toolName: string, args: Record<string, unknown>): boolean;
  /** 拦截理由；isBlocked 为 true 时必有。 */
  blockedReason(toolName: string): string;
  /** 引导正文（随跨轮次状态注入为尾部 user 消息）。 */
  promptSection(): string;
  /** 计划正文必须能以一级标题开头（评审需要名字）。 */
  hasPlanHeading(plan: string): boolean;
  /** 取计划第一行标题，作评审弹窗标题。 */
  planHeading(plan: string): string | undefined;
  /** 计划落盘路径（`<sessionDir>/<sessionId>.plan.md`）。 */
  planFilePath(sessionDir: string, sessionId: string): string;
}

/** plan mode 服务的注册名。核心与插件都引这里。 */
export const PLAN_MODE_SERVICE = 'plan';

// ---------------------------------------------------------------------------
// sandbox 后端接缝
//
// 沙箱是四个能力里唯一**不能把策略交给插件**的：`assertWriteAllowed`（read-only 下拒绝
// write/edit）由核心工具在每次执行时调用，插件缺席时 fail-open 等于放开写权限，fail-closed
// 等于整个 sph 不能写文件——安全约束不能有「缺席」状态。
//
// 可插件化的是**引擎**：Windows restricted-token / Linux bwrap 是机制不是策略。核心保留
// `SandboxHandle` 接口与 fail-closed 分派（`--sandbox off` 之外的模式必须有后端，否则拒绝
// 启动），插件按注册名提供后端。dsh 也是这么切的：`dsh-sandbox` 是接缝，`dsh-sandbox-local`
// / `dsh-sandbox-windows-acl` / `e2b` 是插件提供的后端。

import type { SandboxHandle, SandboxMode } from '../sandbox/types.js';

/**
 * 沙箱后端工厂。核心在需要「真正 confine」的档位（workspace / read-only）时向插件取后端；
 * 插件缺席 → 后端不存在 → 核心 fail-closed 拒绝启动，而不是放开。
 */
export type SandboxBackendFactory = (
  mode: SandboxMode,
  workspaceRoot: string,
) => Promise<SandboxHandle>;

/** `sandbox` 服务的注册名。核心与插件都引这里。 */
export const SANDBOX_SERVICE = 'sandbox';
