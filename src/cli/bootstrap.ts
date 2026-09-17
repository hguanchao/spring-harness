/**
 * 运行时装配：把「配置 → 信任 → 会话锁 → 沙箱 → 会话 → client/MCP/运行时资源」这段
 * 与界面无关的准备过程集中到一处，headless 与 TUI 两条路径共用。
 *
 * 抽出来的动因是清理逻辑：jobs/mcp/sandbox/锁文件/temp 目录必须在所有退出
 * 路径上一起释放。两份拷贝迟早会漂移成「headless 释放了、TUI 漏了」这类难查的泄漏。
 *
 * 失败一律抛 CliError（带退出码），由调用方统一打印——这样退出码语义只定义一次。
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { anthropicAdapter } from '../llm/anthropic.js';
import { openaiAdapter, type LlmClient, type ReasoningEffort } from '../llm/openai.js';
import { responsesAdapter } from '../llm/responses.js';
import type { ProtocolAdapter } from '../llm/stream-client.js';
import { createSseClient } from '../llm/stream-client.js';
import { readModelMeta } from '../llm/model-cache.js';
import { McpHub, type McpReloadResult } from '../mcp/hub.js';
import { discoverMcpServers, type McpPreferences, type McpSourceReport } from '../mcp/sources.js';
import { JobBoard } from '../runtime/jobs.js';
import { TodoList } from '../runtime/todos.js';
import { WorktreeStore } from '../runtime/worktrees.js';
import { openSandbox } from '../sandbox/open.js';
import { SandboxError, type SandboxHandle, type SandboxMode } from '../sandbox/types.js';
import { acquireSessionLock, SessionLockedError } from '../session/lock.js';
import { sessionDirFor } from '../session/path.js';
import { jsonlSessionFactory, resumeOrCreate, setCurrentSession, JsonlSession } from '../session/store.js';
import type { SessionFactory } from '../session/types.js';
import { runTurn, type AgentDriver } from '../agent/loop.js';
import { defaultTools } from '../tools/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import { ConfigError, loadConfig, readMcpPreferences, type ApiProtocol, type SphConfig } from '../config/load.js';
import type { CompatProfile } from '../llm/compat.js';
import { applyProxy } from '../net/proxy.js';
import { mergePresetHeaders } from '../llm/presets.js';
import { sphConfigPath } from '../home.js';
import { isWorkspaceTrusted, rememberTrustedWorkspace } from '../workspace/trust.js';

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  api: ApiProtocol;
  reasoningEffort?: ReasoningEffort;
  maxTokens?: number;
  /** 附加静态请求头：穿透到 createSseClient，与协议默认头同名时以它为准。 */
  headers?: Record<string, string>;
  /** Anthropic prompt-cache 断点开关；省略视作开。 */
  promptCache?: boolean;
  /**
   * 会话身份：OpenAI 系的 `prompt_cache_key` 与亲和头都从它来。
   * 辅助 client 也传同一个 id——缓存路由按「桶」分机，不影响按前缀判定的缓存本身，
   * 反而让主对话与压缩摘要尽量落在同一台机器上。
   */
  sessionId?: string;
  /** `[compat]` 声明，覆盖 URL 推断。 */
  compat?: CompatProfile;
  /** 上游失败重试次数（不含首次）；省略走 client 内置默认。 */
  maxRetries?: number;
}

const adapters = new Map<ApiProtocol, ProtocolAdapter>([
  ['chat-completions', openaiAdapter],
  ['responses', responsesAdapter],
  ['anthropic-messages', anthropicAdapter],
]);

/** 注册或覆盖一种上游协议适配器。同名后写覆盖前写。 */
export function registerAdapter(api: ApiProtocol, adapter: ProtocolAdapter): void {
  adapters.set(api, adapter);
}

/** 按上游协议构造 client；三种协议共享同一 LlmClient 面，loop 无感知。 */
export function createClient(options: ClientOptions): LlmClient {
  const { api, ...conn } = options;
  const adapter = adapters.get(api);
  if (!adapter) throw new Error(`unknown api protocol: ${api}`);
  return createSseClient(adapter, conn);
}

export interface BootstrapOptions {
  workspaceRoot: string;
  /**
   * 项目级 MCP 配置的查找起点，向上走到 `workspaceRoot`（含）。
   *
   * `workspaceRoot` 通常已经是 git 根，但启动目录可能在它下面的某个子目录里，而
   * 「最近的配置优先」要靠这一段查找链。省略则用 `process.cwd()`。
   */
  startDir?: string;
  /** 沙箱档位覆盖（`--sandbox`）。 */
  sandboxOverride?: SandboxMode;
  /** `--trust`：先记下信任再检查。 */
  trust: boolean;
  /**
   * 未信任工作区的处置方式：
   * headless 只能报错退出（无人可问），TUI 可以在终端里问一次。
   */
  untrusted: 'error' | 'confirm';
  /** TUI 启动前的信任确认；headless 不提供，继续走 fail-closed。 */
  confirmUntrustedWorkspace?: (workspaceRoot: string) => Promise<boolean>;
  /** `-c` / `--continue`：续用本工作区最近一次会话；省略则新建（与 pi 的默认一致）。 */
  continueSession: boolean;
  /** `--resume <id>`：打开指定会话。 */
  resumeId?: string;
  model?: string;
  api?: ApiProtocol;
  effort?: ReasoningEffort;
  maxTokens?: number;
}

export interface Runtime {
  workspaceRoot: string;
  sessionDir: string;
  config: SphConfig;
  /** config.toml 路径：TUI 把 /model、/effort、/approval 的选择写回这里。 */
  configPath: string;
  sandbox: SandboxHandle;
  session: JsonlSession;
  tools: ToolRegistry;
  sessions: SessionFactory;
  driver: AgentDriver;
  mcp: McpHub;
  /** 可变容器：`/mcps` 刷新后就地替换内容，持有者无需重新取。 */
  mcpWarnings: string[];
  /** 重新发现并装载 MCP server；启动时首次调用与 `/mcps` 的刷新走同一条路径。 */
  reloadMcp(): Promise<McpReloadResult>;
  /** 重新读 `[mcp]` 偏好段（TUI 写回 config.toml 之后调用）。 */
  refreshMcpPreferences(): void;
  /** 最近一次发现里各候选来源文件的读取结果。 */
  readonly mcpSources: McpSourceReport[];
  /** 生效中的 MCP 启停偏好（写回后由 refreshMcpPreferences 更新）。 */
  readonly mcpPreferences: McpPreferences;
  todos: TodoList;
  jobs: JobBoard;
  /** 子代理 worktree 隔离的工作树仓库；cleanup 负责清退。 */
  worktrees: WorktreeStore;
  /** 按覆盖参数重建 client（TUI 的 /model、/effort 用）。 */
  makeClient(overrides: {
    model: string;
    api: ApiProtocol;
    effort?: ReasoningEffort;
    maxTokens?: number;
    /** 省略用主端点；辅助模型跨厂商时由 makeAuxClient 传入。 */
    baseUrl?: string;
    apiKey?: string;
  }): LlmClient;
  /**
   * 辅助调用（压缩摘要 / auto 审批审查器）的 client。
   *
   * 模型名省略时返回 undefined，调用方据此回退主 client。配置了 `[aux]` 就用它的端点，
   * 否则复用主端点——「便宜的辅助模型」因此跨厂商也成立。
   *
   * 收敛在这一个方法里，是因为 headless 与 TUI 各写一遍正是 TUI 那侧漏接线、
   * 让 `compact_model` 静默失效的原因。
   */
  makeAuxClient(model: string | undefined): LlmClient | undefined;
  /**
   * 把会话锁换到另一个 id（TUI `/new`、`/sessions`）。
   * 先拿到新锁再放旧锁：失败时当前会话仍占用，不会两边落空。
   */
  claimSession(id: string): void;
  /** 幂等清理：所有退出路径都调它。 */
  cleanup(): void;
}

export async function bootstrapRuntime(options: BootstrapOptions): Promise<Runtime> {
  let config: SphConfig;
  try {
    config = loadConfig({ sandboxOverride: options.sandboxOverride });
  } catch (error) {
    if (error instanceof ConfigError) throw new CliError(error.message, 2);
    throw error;
  }
  // 代理是进程级出网开关，必须在任何可能出网的步骤（MCP、模型目录预热）之前装好。
  applyProxy(config.proxy);

  // `--model` 切到一个配置里没记过的模型时，用本地沉淀的容量参数补上 context_window /
  // max_tokens——否则每换一次模型都要手改配置，忘了就把窗口算错。显式 CLI 参数仍然优先。
  if (options.model !== undefined && options.model !== config.model) {
    const meta = readModelMeta(config.baseUrl, options.model);
    if (meta) {
      config = {
        ...config,
        contextWindow: meta.contextWindow ?? config.contextWindow,
        maxTokens: meta.maxTokens ?? config.maxTokens,
      };
    }
  }

  // 有效主协议：`--api` 覆盖配置。辅助端点没显式声明协议时沿用它——辅助模型与主模型
  // 通常同源，协议不一致会直接发错端点。
  const mainApi: ApiProtocol = options.api ?? config.api;

  if (options.trust) rememberTrustedWorkspace(options.workspaceRoot);
  if (!isWorkspaceTrusted(options.workspaceRoot)) {
    if (options.untrusted === 'error') {
      throw new CliError(
        `workspace is not trusted: ${options.workspaceRoot}\npass --trust to remember it (does not imply --yolo).`,
        2,
      );
    }
    const ok = options.confirmUntrustedWorkspace
      ? await options.confirmUntrustedWorkspace(options.workspaceRoot)
      : await confirmTrust(options.workspaceRoot);
    if (!ok) throw new CliError(`workspace is not trusted: ${options.workspaceRoot}`, 2);
    rememberTrustedWorkspace(options.workspaceRoot);
  }

  const sessionDir = sessionDirFor(options.workspaceRoot);
  mkdirSync(sessionDir, { recursive: true });

  let sandbox: SandboxHandle;
  try {
    sandbox = await openSandbox(config.sandbox, options.workspaceRoot);
  } catch (error) {
    if (error instanceof SandboxError) throw new CliError(error.message, 1);
    throw error;
  }

  // 会话选择与 pi 对齐：默认新建；只有 `-c/--continue` 才续用最近一次主会话。
  let session = await resumeOrCreate(sessionDir, options.workspaceRoot, !options.continueSession);
  if (options.resumeId) {
    const file = join(sessionDir, `${options.resumeId}.jsonl`);
    if (!existsSync(file)) {
      sandbox.dispose();
      throw new CliError(`session not found: ${options.resumeId} (see: sph sessions)`, 1);
    }
    setCurrentSession(sessionDir, options.resumeId, options.workspaceRoot);
    session = new JsonlSession(sessionDir, options.resumeId);
  }

  let release: (() => void) | undefined;
  try {
    release = acquireSessionLock(sessionDir, session.id);
  } catch (error) {
    sandbox.dispose();
    if (error instanceof SessionLockedError) throw new CliError(error.message, 1);
    throw error;
  }

  const mcp = new McpHub();
  // 可变容器：`/mcps` 刷新后警告要就地替换，任何持有它的地方都看到最新一批。
  const mcpWarnings: string[] = [];
  // 握手已改为后台完成（启动不为此阻塞），失败不再走 reload 的返回值——接到这个回调里，
  // 警告容器与 /mcps 弹窗才能看见「server 没起来」。刷新会清空容器重填，过期的失败警告
  // 不会永久残留；TUI 不为此弹 toast，状态以 /mcps 为准。
  mcp.onProblem = (message) => {
    if (!mcpWarnings.includes(message)) mcpWarnings.push(message);
  };
  let mcpReports: McpSourceReport[] = [];
  const preferences = { ...config.mcpPreferences };

  const reloadMcp = async (): Promise<McpReloadResult> => {
    const discovery = discoverMcpServers({
      workspaceRoot: options.workspaceRoot,
      fromDir: options.startDir ?? process.cwd(),
      preferences,
    });
    mcpReports = discovery.reports;
    const result = await mcp.reload(discovery.servers);
    // 顺序即因果：先有来源读取的问题，再有装载的问题，最后是 `[mcp]` 偏好的提示。
    mcpWarnings.length = 0;
    mcpWarnings.push(...discovery.warnings, ...result.warnings);
    return result;
  };
  await reloadMcp();

  const todos = new TodoList();
  const jobs = new JobBoard();
  const worktrees = new WorktreeStore();

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    jobs.abortAll();
    mcp.dispose();
    // 干净的隔离工作树移除（提交留在 sph/<id> 分支）；有未提交改动的一律保留并报告
    // 路径——绝不静默丢弃子代理的工作。
    for (const path of worktrees.dispose().kept) {
      process.stderr.write(`worktree with uncommitted changes kept: ${path}\n`);
    }
    sandbox.dispose();
    release?.();
    try {
      // temp 目录可能已被外部清理掉
      rmSync(sandbox.tempDir, { recursive: true, force: true });
    } catch {
      // 忽略
    }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });

  return {
    workspaceRoot: options.workspaceRoot,
    sessionDir,
    config,
    configPath: sphConfigPath(),
    sandbox,
    session,
    tools: defaultTools,
    sessions: jsonlSessionFactory,
    driver: runTurn,
    mcp,
    mcpWarnings,
    todos,
    jobs,
    worktrees,
    claimSession(id) {
      const next = acquireSessionLock(sessionDir, id);
      release?.();
      release = next;
    },
    makeClient(overrides) {
      const baseUrl = overrides.baseUrl ?? config.baseUrl;
      return createClient({
        baseUrl,
        apiKey: overrides.apiKey ?? config.apiKey,
        model: overrides.model,
        api: overrides.api,
        reasoningEffort: overrides.effort,
        maxTokens: overrides.maxTokens ?? options.maxTokens ?? config.maxTokens,
        headers: mergePresetHeaders(baseUrl, config.httpHeaders),
        promptCache: config.promptCache,
        sessionId: session.id,
        compat: config.compat,
        maxRetries: config.maxRetries,
      });
    },
    makeAuxClient(model) {
      if (model === undefined) return undefined;
      // 没配 [aux].base_url 就是与主端点同源：此时协议跟随主配置（含 --api 覆盖）。
      const sharesMainEndpoint = config.aux?.baseUrl === undefined;
      return createClient({
        baseUrl: config.aux?.baseUrl ?? config.baseUrl,
        apiKey: config.aux?.apiKey ?? config.apiKey,
        model,
        api: config.aux?.api ?? mainApi,
        reasoningEffort: config.reasoningEffort,
        // max_tokens 只在同源时继承：不同厂商的输出上限不同，把主模型的限额发给别人的模型
        // 会直接 400。跨端点时交给端点默认值（anthropic 适配层自带 8192 兜底）。
        maxTokens: sharesMainEndpoint ? config.maxTokens : undefined,
        headers: mergePresetHeaders(config.aux?.baseUrl ?? config.baseUrl, config.httpHeaders),
        promptCache: config.promptCache,
        sessionId: session.id,
        // 跨端点时用 [aux.compat]；同源则复用主 [compat]。
        compat: sharesMainEndpoint ? config.compat : config.aux?.compat,
        maxRetries: config.maxRetries,
      });
    },
    reloadMcp,
    refreshMcpPreferences() {
      const fresh = readMcpPreferences(sphConfigPath());
      // 读不回来就保持旧值：偏好刚写完，此时解析失败意味着文件被别的东西弄坏了，
      // 用空偏好覆盖会让用户刚做的开关凭空消失。
      if (fresh === undefined) return;
      preferences.disabledServers = fresh.disabledServers;
      preferences.enabledServers = fresh.enabledServers;
    },
    get mcpSources() {
      return mcpReports;
    },
    get mcpPreferences() {
      return preferences;
    },
    cleanup,
  };
}

/** 未信任工作区的交互确认：信任意味着 AGENTS.md 与工具都能在该目录生效，必须显式同意。 */
async function confirmTrust(workspaceRoot: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(
        `workspace is not trusted: ${workspaceRoot}\nAGENTS.md and tools will act inside it. trust this workspace? [y/N] `,
        resolve,
      );
    });
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
