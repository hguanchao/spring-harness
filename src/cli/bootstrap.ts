/**
 * 运行时装配：把「配置 → 信任 → 会话锁 → 沙箱 → 会话 → client/MCP/运行时资源」这段
 * 与界面无关的准备过程集中到一处，headless 与 TUI 两条路径共用。
 *
 * 抽出来的动因是清理逻辑：jobs/persistent/mcp/sandbox/锁文件/temp 目录必须在所有退出
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
import { McpHub } from '../mcp/hub.js';
import { JobBoard } from '../runtime/jobs.js';
import { PersistentShell } from '../runtime/persistent-shell.js';
import { TodoList } from '../runtime/todos.js';
import { openSandbox, type SandboxHandle } from '../sandbox/open.js';
import { SandboxError, type SandboxMode } from '../sandbox/types.js';
import { acquireSessionLock, SessionLockedError } from '../session/lock.js';
import { sessionDirFor } from '../session/path.js';
import { forkSession, resumeOrCreate, setCurrentSession, JsonlSession } from '../session/store.js';
import { ConfigError, loadConfig, type ApiProtocol, type SphConfig } from '../config/load.js';
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
}

/** 按上游协议构造 client；三种协议共享同一 LlmClient 面，loop 无感知。 */
export function createClient(options: ClientOptions): LlmClient {
  const { api, ...conn } = options;
  if (api === 'anthropic-messages') return createSseClient(anthropicAdapter, conn);
  if (api === 'responses') return createSseClient(responsesAdapter, conn);
  return createSseClient(openaiAdapter, conn);
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
  newSession: boolean;
  resumeId?: string;
  fork: boolean;
  model?: string;
  api?: ApiProtocol;
  effort?: ReasoningEffort;
  maxTokens?: number;
}

export interface Runtime {
  workspaceRoot: string;
  sessionDir: string;
  config: SphConfig;
  sandbox: SandboxHandle;
  session: JsonlSession;
  mcp: McpHub;
  mcpWarnings: string[];
  todos: TodoList;
  jobs: JobBoard;
  persistent: PersistentShell;
  /** 按覆盖参数重建 client（TUI 的 /model、/effort 用）。 */
  makeClient(overrides: { model: string; api: ApiProtocol; effort?: ReasoningEffort }): LlmClient;
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

  if (options.trust) rememberTrustedWorkspace(options.workspaceRoot);
  if (!isWorkspaceTrusted(options.workspaceRoot)) {
    if (options.untrusted === 'error') {
      throw new CliError(
        `workspace is not trusted: ${options.workspaceRoot}\npass --trust to remember it (does not imply --yolo).`,
        2,
      );
    }
    const ok = await confirmTrust(options.workspaceRoot);
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

  let session = resumeOrCreate(sessionDir, options.workspaceRoot, options.newSession);
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
  if (options.fork) session = forkSession(sessionDir, session, options.workspaceRoot);

  const mcp = new McpHub();
  const mcpWarnings = await mcp.connect(config.mcpServers);
  const todos = new TodoList();
  const jobs = new JobBoard(sandbox);
  const persistent = new PersistentShell(sandbox, options.workspaceRoot);

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    jobs.abortAll();
    persistent.dispose();
    mcp.dispose();
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
    sandbox,
    session,
    mcp,
    mcpWarnings,
    todos,
    jobs,
    persistent,
    makeClient(overrides) {
      return createClient({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: overrides.model,
        api: overrides.api,
        reasoningEffort: overrides.effort,
        maxTokens: options.maxTokens ?? config.maxTokens,
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
