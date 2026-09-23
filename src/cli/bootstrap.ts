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
import type { LlmClient, ReasoningEffort } from '../llm/client.js';
import { PluginHost } from '../plugins/host.js';
import { discoverPlugins, userPluginsRoot } from '../plugins/loader.js';
import {
  EMPTY_TODO,
  LOOP_SERVICE,
  MCP_SERVICE,
  MODEL_SERVICE,
  SANDBOX_SERVICE,
  SCHEDULER_SERVICE,
  SESSION_SERVICE,
  TODO_SERVICE,
  UI_SERVICE,
  type LoopService,
  type ModelService,
  type SandboxBackendFactory,
  type McpPreferences,
  type McpReloadResult,
  type McpService,
  type SchedulerService,
  type SessionService,
  type TodoService,
  type UiService,
  type WorktreePort,
} from '../plugins/services.js';
import { openSandbox } from '../sandbox/open.js';
import { SandboxError, type SandboxHandle, type SandboxMode } from '../sandbox/types.js';
import type { SessionFactory, SessionPort } from '../session/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import { ConfigError, loadConfig, readMcpPreferences, type ApiProtocol, type SphConfig } from '../config/load.js';
import {
  findProvider,
  loadRegistry,
  resolveModel,
  splitProviderModel,
  type ModelRegistry,
  type ResolvedModel,
} from '../config/registry.js';
import { sphConfigPath, sphModelsPath } from '../home.js';
import { applyProxy } from '../net/proxy.js';
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
  /** config.toml 路径：TUI 把 /model、/effort、/permission 的选择写回这里。 */
  configPath: string;
  sandbox: SandboxHandle;
  session: SessionPort;
  tools: ToolRegistry;
  sessions: SessionFactory;
  driver: LoopService['runTurn'];
  /** 插件宿主：工具表（核心 + 插件）、服务表、清理都归它。 */
  plugins: PluginHost;
  /**
   * `sph-mcp` 插件提供的服务；插件未装载（被 `[plugins] disabled` 关掉或加载失败）时为
   * undefined——界面据此如实显示「MCP 插件没装」，而不是假装没有 server。
   */
  mcp(): McpService | undefined;
  /** 重新发现并装载 MCP server；启动时首次调用与 `/mcps` 的刷新走同一条路径。 */
  reloadMcp(): Promise<McpReloadResult>;
  /** 重新读 `[mcp]` 偏好段（TUI 写回 config.toml 之后调用）。 */
  refreshMcpPreferences(): void;
  /** 生效中的 MCP 启停偏好（写回后由 refreshMcpPreferences 更新）。 */
  readonly mcpPreferences: McpPreferences;
  /** todo 服务（todo 插件提供；缺席即不可用）。 */
  todos: TodoService;
  jobs: ReturnType<SchedulerService['create']>;
  /** 子代理 worktree 隔离的工作树仓库；cleanup 负责清退。 */
  worktrees: WorktreePort;
  /** models.json 的声明：`/model` 列表与按模型解析协议都从这里来。 */
  readonly registry: ModelRegistry;
  /** 按模型 id 解析生效协议与容量声明；未声明的模型回落 provider 级。 */
  resolveModel(options: { model: string; provider?: string; api?: ApiProtocol }): ResolvedModel;
  /** 按覆盖参数重建 client（TUI 的 /model、/effort 用）；api 省略时按声明解析。 */
  makeClient(overrides: {
    model: string;
    provider?: string;
    api?: ApiProtocol;
    effort?: ReasoningEffort;
    maxTokens?: number;
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
   * 把会话锁换到另一个 id（TUI `/new`、`/resume`）。
   * 先拿到新锁再放旧锁：失败时当前会话仍占用，不会两边落空。
   */
  claimSession(id: string): void;
  /** 幂等清理：所有退出路径都调它。 */
  cleanup(): void;
}

export async function bootstrapRuntime(options: BootstrapOptions): Promise<Runtime> {
  let config: SphConfig;
  let registry: ModelRegistry;
  try {
    registry = loadRegistry(sphModelsPath());
    config = loadConfig({ sandboxOverride: options.sandboxOverride });
  } catch (error) {
    if (error instanceof ConfigError) throw new CliError(error.message, 2);
    throw error;
  }
  // 代理是进程级出网开关，必须在任何可能出网的步骤（MCP、模型目录预热）之前装好。
  applyProxy(config.proxy);

  // `--model` 支持 `provider/id` 限定（id 含斜杠且前缀不是已声明 provider 名时仍当模型 id）。
  // 命中的模型若是声明的，其 contextWindow / maxTokens / api 一并生效——否则每换一次模型
  // 都要手改配置，忘了就把窗口算错。显式 CLI 参数仍然优先。
  let providerName = config.provider;
  let effectiveModel = config.model;
  if (options.model !== undefined) {
    const split = splitProviderModel(registry.providers, options.model);
    if (split.provider !== undefined) providerName = split.provider;
    effectiveModel = split.model;
  }
  if (providerName !== config.provider || effectiveModel !== config.model || options.api !== undefined) {
    const provider = findProvider(registry, providerName);
    const resolved = resolveModel(provider, effectiveModel, { apiOverride: options.api });
    config = {
      ...config,
      provider: providerName,
      model: effectiveModel,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      httpHeaders: provider.headers,
      ...(resolved.compat === undefined ? {} : { compat: resolved.compat }),
      api: resolved.api,
      contextWindow: resolved.contextWindow ?? config.contextWindow,
      maxTokens: resolved.maxTokens ?? config.maxTokens,
    };
  }

  if (options.trust) rememberTrustedWorkspace(options.workspaceRoot);

  // 核心工具表是空的。read / write / shell 由 sph-tools 注册，模型、会话、循环、调度同理。
  // 项目级插件受信任门保护——仓库里的 .sph/plugins 是会被执行的代码。
  const openPlugins = async (trusted: boolean): Promise<PluginHost> => {
    const host = new PluginHost({
      coreTools: [],
      workspaceRoot: options.workspaceRoot,
      configPath: sphConfigPath(),
    });
    const discovered = discoverPlugins({
      workspaceRoot: options.workspaceRoot,
      userRoot: userPluginsRoot(),
      trusted,
      disabled: config.disabledPlugins,
    });
    // 内置插件被顶掉是合法的（就地打补丁），但必须说出来。sph-sandbox 例外：
    // 同名第三方被发现阶段丢掉，内置后端留下，这里只报告那次被拒绝的替换。
    for (const name of discovered.shadowed) {
      process.stderr.write(`warning: plugin ${name} shadows the bundled one\n`);
    }
    for (const name of discovered.pinned) {
      process.stderr.write(`warning: plugin ${name} cannot replace the bundled one; the built-in stays loaded\n`);
    }
    await host.load(discovered.candidates, discovered.shadowed, discovered.pinned);
    for (const warning of host.warnings()) process.stderr.write(`warning: ${warning}\n`);
    return host;
  };

  // 未信任时先只装内置和用户插件，好让界面插件画出信任页。同意之后再整表重装，
  // 项目级插件才能进来。headless 没有人可问，这里直接拒绝。
  if (!isWorkspaceTrusted(options.workspaceRoot)) {
    if (options.untrusted === 'error') {
      throw new CliError(
        `workspace is not trusted: ${options.workspaceRoot}\npass --trust to remember it (does not imply --yolo).`,
        2,
      );
    }
    const preview = await openPlugins(false);
    const ui = preview.get<UiService>(UI_SERVICE);
    const ok = options.confirmUntrustedWorkspace
      ? await options.confirmUntrustedWorkspace(options.workspaceRoot)
      : ui
        ? await ui.confirmTrust(options.workspaceRoot)
        : await confirmTrust(options.workspaceRoot);
    preview.dispose();
    if (!ok) throw new CliError(`workspace is not trusted: ${options.workspaceRoot}`, 2);
    rememberTrustedWorkspace(options.workspaceRoot);
  }
  // 走到这里工作区必定已信任。仍然显式取一次而不是写死 true：插件发现吃这个值。
  const trusted = isWorkspaceTrusted(options.workspaceRoot);
  const plugins = await openPlugins(trusted);

  const requireService = <T>(name: string): T => {
    const found = plugins.get<T>(name);
    if (found !== undefined) return found;
    plugins.dispose();
    throw new CliError(`plugin service ${name} is not loaded`, 1);
  };
  const sessionApi = requireService<SessionService>(SESSION_SERVICE);
  const model = requireService<ModelService>(MODEL_SERVICE);
  const loop = requireService<LoopService>(LOOP_SERVICE);
  const scheduler = requireService<SchedulerService>(SCHEDULER_SERVICE);

  const sessionDir = sessionApi.sessionDirFor(options.workspaceRoot);
  mkdirSync(sessionDir, { recursive: true });

  // confine 档位必须有后端。插件缺席或装载失败 → 拒绝启动，而不是放开约束。
  const sandboxFactory = plugins.get<SandboxBackendFactory>(SANDBOX_SERVICE);
  let sandbox: SandboxHandle;
  try {
    sandbox = await openSandbox(config.sandbox, options.workspaceRoot, sandboxFactory);
  } catch (error) {
    plugins.dispose();
    if (error instanceof SandboxError) throw new CliError(error.message, 1);
    throw error;
  }

  // 会话选择与 pi 对齐：默认新建；只有 `-c/--continue` 才续用最近一次主会话。
  let session = await sessionApi.resumeOrCreate(sessionDir, options.workspaceRoot, !options.continueSession);
  if (options.resumeId) {
    const file = join(sessionDir, `${options.resumeId}.jsonl`);
    if (!existsSync(file)) {
      sandbox.dispose();
      plugins.dispose();
      throw new CliError(`session not found: ${options.resumeId} (see: sph sessions)`, 1);
    }
    sessionApi.activate(sessionDir, options.resumeId, options.workspaceRoot);
    session = sessionApi.open(sessionDir, options.resumeId);
  }

  let release: (() => void) | undefined;
  try {
    release = sessionApi.acquireLock(sessionDir, session.id);
  } catch (error) {
    sandbox.dispose();
    plugins.dispose();
    if (sessionApi.isLockError(error)) throw new CliError(error instanceof Error ? error.message : String(error), 1);
    throw error;
  }

  const preferences = { ...config.mcpPreferences };

  /**
   * MCP 的域逻辑全在插件里，这里只做两件事：把宿主事实交给它，把结果转给界面。
   * 服务缺席（插件被禁用或加载失败）时返回空结果而不是抛错——`/mcps` 会如实说明
   * 「MCP 插件没装」，这比让整个命令域崩掉有用。
   */
  const mcp = (): McpService | undefined => plugins.get<McpService>(MCP_SERVICE);
  const EMPTY_RELOAD: McpReloadResult = { warnings: [], added: [], removed: [], restarted: [] };
  const reloadMcp = async (): Promise<McpReloadResult> => {
    const service = mcp();
    if (!service) return EMPTY_RELOAD;
    return service.reload({
      workspaceRoot: options.workspaceRoot,
      fromDir: options.startDir ?? process.cwd(),
      preferences,
      trusted,
    });
  };
  await reloadMcp();

  const todos = plugins.get<TodoService>(TODO_SERVICE) ?? EMPTY_TODO;
  const jobs = scheduler.create();
  const worktrees = loop.createWorktrees();

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    jobs.abortAll();
    // 插件逆序清理：sph-mcp 在这里关掉所有 MCP 子进程。
    plugins.dispose();
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
    tools: plugins.tools(),
    sessions: sessionApi.factory,
    driver: loop.runTurn,
    plugins,
    mcp,

    todos,
    jobs,
    worktrees,
    claimSession(id) {
      const next = sessionApi.acquireLock(sessionDir, id);
      release?.();
      release = next;
    },
    registry,
    resolveModel(options) {
      const provider = options.provider === undefined
        ? findProvider(registry, config.provider)
        : findProvider(registry, options.provider);
      return resolveModel(provider, options.model, { apiOverride: options.api });
    },
    makeClient(overrides) {
      const provider = overrides.provider === undefined
        ? findProvider(registry, config.provider)
        : findProvider(registry, overrides.provider);
      const resolved = resolveModel(provider, overrides.model, { apiOverride: overrides.api });
      return model.createClient({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: overrides.model,
        api: resolved.api,
        reasoningEffort: overrides.effort,
        maxTokens: overrides.maxTokens ?? options.maxTokens ?? config.maxTokens,
        headers: provider.headers,
        promptCache: config.promptCache,
        sessionId: session.id,
        compat: resolved.compat,
        maxRetries: config.maxRetries,
      });
    },
    makeAuxClient(auxModel) {
      if (auxModel === undefined) return undefined;
      // 没配 [aux].provider 就是与主端点同源。辅助模型的协议与 compat 按 aux provider
      // 的声明解析——「便宜的辅助模型」因此跨厂商也成立。
      const auxProvider = config.aux?.provider === undefined
        ? findProvider(registry, config.provider)
        : findProvider(registry, config.aux.provider);
      const sharesMainEndpoint = auxProvider.name === config.provider;
      const resolved = resolveModel(auxProvider, auxModel);
      return model.createClient({
        baseUrl: auxProvider.baseUrl,
        apiKey: auxProvider.apiKey,
        model: auxModel,
        api: resolved.api,
        reasoningEffort: config.reasoningEffort,
        // max_tokens 只在同源时继承：不同厂商的输出上限不同，把主模型的限额发给别人的模型
        // 会直接 400。跨端点时交给端点默认值（anthropic 适配层自带 8192 兜底）。
        maxTokens: sharesMainEndpoint ? config.maxTokens : undefined,
        headers: auxProvider.headers,
        promptCache: config.promptCache,
        sessionId: session.id,
        compat: resolved.compat,
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
      preferences.lazyServers = fresh.lazyServers;
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
