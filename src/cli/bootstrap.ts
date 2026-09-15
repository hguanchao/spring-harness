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
import { openaiAdapter, type ReasoningEffort } from '../llm/openai.js';
import type { LlmClient } from '../llm/openai.js';
import { responsesAdapter } from '../llm/responses.js';
import { createSseClient } from '../llm/stream-client.js';
import { readModelMeta } from '../llm/model-cache.js';
import { McpHub } from '../mcp/hub.js';
import { JobBoard } from '../runtime/jobs.js';
import { TodoList } from '../runtime/todos.js';
import { WorktreeStore } from '../runtime/worktrees.js';
import { openSandbox, type SandboxHandle } from '../sandbox/open.js';
import { SandboxError, type SandboxMode } from '../sandbox/types.js';
import { acquireSessionLock, SessionLockedError } from '../session/lock.js';
import { sessionDirFor } from '../session/path.js';
import { resumeOrCreate, setCurrentSession, JsonlSession } from '../session/store.js';
import { ConfigError, loadConfig, type ApiProtocol, type SphConfig } from '../config/load.js';
import { applyProxy } from '../net/proxy.js';
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
}

/** 按上游协议构造 client；三种协议共享同一 LlmClient 面，loop 无感知。 */
export function createClient(options: ClientOptions): LlmClient {
  const { api, ...conn } = options;
  // 三分支只在 adapter 上不同,连接参数(含 headers)原样透传,故先选 adapter 再构造一次。
  const adapter = api === 'anthropic-messages'
    ? anthropicAdapter
    : api === 'responses' ? responsesAdapter : openaiAdapter;
  return createSseClient(adapter, conn);
}

export interface BootstrapOptions {
  workspaceRoot: string;
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
  mcp: McpHub;
  mcpWarnings: string[];
  todos: TodoList;
  jobs: JobBoard;
  /** 子代理 worktree 隔离的工作树仓库；cleanup 负责清退。 */
  worktrees: WorktreeStore;
  /** 按覆盖参数重建 client（TUI 的 /model、/effort 用）。 */
  makeClient(overrides: { model: string; api: ApiProtocol; effort?: ReasoningEffort; maxTokens?: number }): LlmClient;
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

  let release: (() => void) | undefined;
  try {
    release = acquireSessionLock(sessionDir);
  } catch (error) {
    if (error instanceof SessionLockedError) throw new CliError(error.message, 1);
    throw error;
  }

  let sandbox: SandboxHandle;
  try {
    sandbox = await openSandbox(config.sandbox, options.workspaceRoot);
  } catch (error) {
    release();
    if (error instanceof SandboxError) throw new CliError(error.message, 1);
    throw error;
  }

  // 会话选择与 pi 对齐：默认新建；只有 `-c/--continue` 才续用最近一次主会话。
  let session = await resumeOrCreate(sessionDir, options.workspaceRoot, !options.continueSession);
  if (options.resumeId) {
    const file = join(sessionDir, `${options.resumeId}.jsonl`);
    if (!existsSync(file)) {
      sandbox.dispose();
      release();
      throw new CliError(`session not found: ${options.resumeId} (see: sph sessions)`, 1);
    }
    setCurrentSession(sessionDir, options.resumeId, options.workspaceRoot);
    session = new JsonlSession(sessionDir, options.resumeId);
  }

  const mcp = new McpHub();
  const mcpWarnings = await mcp.connect(config.mcpServers);
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
    release();
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
    mcp,
    mcpWarnings,
    todos,
    jobs,
    worktrees,
    makeClient(overrides) {
      return createClient({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: overrides.model,
        api: overrides.api,
        reasoningEffort: overrides.effort,
        maxTokens: overrides.maxTokens ?? options.maxTokens ?? config.maxTokens,
        headers: config.httpHeaders,
      });
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
