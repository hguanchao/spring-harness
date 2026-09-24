#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { createJsonOutput, createTextOutput } from './output.js';
import { HeadlessApprover, type ApprovalMode } from '../permission/policy.js';
import { createLlmClassifier } from '../permission/auto.js';
import { HELP, parseArgs, type CliArgs } from './args.js';
import { CliError, bootstrapRuntime, type Runtime } from './bootstrap.js';
import { ConfigError, loadConfig } from '../config/load.js';
import { loadRegistry } from '../config/registry.js';
import { sphConfigPath, sphModelsPath, sphSpillRoot } from '../home.js';
import { combineListeners } from '../agent/events.js';
import type { TokenUsage } from '../llm/client.js';
import { PluginHost } from '../plugins/host.js';
import { discoverPlugins, userPluginsRoot } from '../plugins/loader.js';
import { SESSION_SERVICE, STORAGE_SERVICE, UI_SERVICE, type SessionInfo, type SessionService, type StorageService, type UiService } from '../plugins/services.js';
import { resolveWorkspaceRoot } from '../workspace/root.js';
import { isWorkspaceTrusted } from '../workspace/trust.js';

function printSessionInfos(infos: SessionInfo[]): void {
  for (const info of infos) {
    const when = new Date(info.mtimeMs).toISOString().replace('T', ' ').slice(0, 16);
    const hits = info.hits !== undefined ? ` hits=${info.hits}` : '';
    // 子代理会话数是主会话才有的信息：它那些 subagent 块各自是一个独立文件。
    const subs = info.subagents > 0 ? ` subs=${info.subagents}` : '';
    process.stdout.write(`${info.id}  ${when}  msgs=${info.messages}${subs}${hits}  ${info.preview}\n`);
  }
}

/**
 * 只装 sph-session。同名替换会进来，模型、沙箱和 MCP 不会。
 * 插件被关掉或装载失败时返回 undefined，不退回内置实现。
 */
async function loadSessionService(workspaceRoot: string): Promise<SessionService | undefined> {
  let disabled: string[] = [];
  try {
    disabled = loadConfig().disabledPlugins;
  } catch {
    disabled = [];
  }
  const host = new PluginHost({
    coreTools: [],
    workspaceRoot,
    configPath: sphConfigPath(),
  });
  const discovered = discoverPlugins({
    workspaceRoot,
    userRoot: userPluginsRoot(),
    trusted: isWorkspaceTrusted(workspaceRoot),
    disabled,
  });
  const only = discovered.candidates.filter((candidate) => candidate.name === 'sph-session');
  await host.load(only, discovered.shadowed.filter((name) => name === 'sph-session'), []);
  const service = host.get<SessionService>(SESSION_SERVICE);
  if (!service) {
    for (const warning of host.warnings()) process.stderr.write(`warning: ${warning}\n`);
  }
  return service;
}

/** sessions 子命令：列出本工作区的主会话（或按关键词过滤），不进入 agent 运行时。 */
async function runSessionsCommand(workspaceRoot: string, search?: string): Promise<void> {
  const sessionService = await loadSessionService(workspaceRoot);
  if (!sessionService) {
    process.stderr.write('sph-session is not loaded\n');
    process.exitCode = 1;
    return;
  }
  const dir = sessionService.sessionDirFor(workspaceRoot);
  const infos = await sessionService.list(dir, { search });
  printSessionInfos(infos);
  if (infos.length === 0) process.stdout.write(search ? `no session contains "${search}"\n` : 'no sessions yet\n');
}

async function runExportCommand(workspaceRoot: string, sessionId?: string, format: 'md' | 'json' | 'html' = 'md'): Promise<void> {
  const sessionService = await loadSessionService(workspaceRoot);
  if (!sessionService) {
    process.stderr.write('sph-session is not loaded\n');
    process.exitCode = 1;
    return;
  }
  const dir = sessionService.sessionDirFor(workspaceRoot);
  // export 是只读命令：不创建会话，没有可导出内容时报错退出。
  let id = sessionId;
  if (!id) {
    const infos = await sessionService.list(dir);
    id = infos[0]?.id;
    if (!id) {
      process.stderr.write('no sessions to export\n');
      process.exitCode = 1;
      return;
    }
  }
  const file = join(dir, `${id}.jsonl`);
  if (!existsSync(file)) {
    process.stderr.write(`session not found: ${id}\n`);
    process.exitCode = 1;
    return;
  }
  const session = sessionService.open(dir, id);
  const body = format === 'json'
    ? sessionService.exportJson(session)
    : format === 'html'
      ? sessionService.exportHtml(session)
      : sessionService.exportMarkdown(session);
  process.stdout.write(body);
}

/** 统一的装配入口：把 CliError 翻译成 stderr + 退出码，其余异常继续上抛。 */
async function bootstrap(
  args: CliArgs,
  workspaceRoot: string,
  untrusted: 'error' | 'confirm',
  confirmUntrustedWorkspace?: (workspaceRoot: string) => Promise<boolean>,
  onCliError?: (error: CliError) => void,
): Promise<Runtime | undefined> {
  try {
    return await bootstrapRuntime({
      workspaceRoot,
      // 项目级配置的查找链从**启动目录**开始，而不是 workspaceRoot：在仓库的子目录里
      // 启动时，「最近的配置优先」才有意义。
      startDir: process.cwd(),
      sandboxOverride: args.sandbox,
      trust: args.trust,
      untrusted,
      confirmUntrustedWorkspace,
      continueSession: args.continueSession,
      resumeId: args.resumeId,
      model: args.model,
      provider: args.provider,
      api: args.api,
      effort: args.effort,
      maxTokens: args.maxTokens,
    });
  } catch (error) {
    if (error instanceof CliError) {
      process.exitCode = error.exitCode;
      if (onCliError) onCliError(error);
      else process.stderr.write(`${error.message}\n`);
      return undefined;
    }
    throw error;
  }
}

/** 交互模式：无 `-p` 且两端都是 TTY。 */
async function runInteractive(args: CliArgs, workspaceRoot: string): Promise<void> {
  // 非 TTY（管道 / CI）绝不进 TUI：否则会挂住等按键。
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      'missing -p/--prompt: pass "sph -p <prompt>" for one headless turn, or run in an interactive terminal for the TUI (see: sph --help)\n',
    );
    process.exitCode = 2;
    return;
  }

  // 配置都读不出来时不要先画信任页：Yes 之后立刻退屏，看起来像信任页把人踢出去。
  try {
    loadRegistry(sphModelsPath());
    loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  // 信任页和主界面都由 sph-tui 提供。未信任时 bootstrap 先装内置插件，让信任页画出来。
  let runtime: Runtime | undefined;
  let deferredError: string | undefined;
  let ran = false;
  try {
    runtime = await bootstrap(args, workspaceRoot, 'confirm', undefined, (error) => {
      deferredError = error.message;
    });
    if (!runtime) return;
    const screen = runtime.plugins.get<UiService>(UI_SERVICE);
    if (!screen) {
      deferredError = 'interactive mode needs the sph-tui plugin';
      return;
    }
    ran = true;
    await screen.run(runtime, args);
  } finally {
    runtime?.cleanup();
    // 装配失败写在替代屏幕里会被 1049l 清掉，退屏后再打到普通终端。
    if (deferredError !== undefined) process.stderr.write(`${deferredError}\n`);
  }
  // 退回主屏幕后必须结束进程。MCP 孙进程或控制台 stdin 还占着事件循环时，
  // cmd 不打印目录提示符，用户要再按一次 Ctrl+C 才回到 shell。
  if (!ran) return;
  await new Promise<void>((resolve) => {
    process.stdout.write('', () => resolve());
  });
  process.exit(process.exitCode ?? 0);
}

/** headless 路径：一次 runTurn 后退出。除装配外与旧实现逐行一致。 */
async function runHeadless(args: CliArgs, workspaceRoot: string, prompt: string): Promise<void> {
  const runtime = await bootstrap(args, workspaceRoot, 'error');
  if (!runtime) return;
  const { session, sandbox, todos, jobs, config } = runtime;
  try {
    // 插件问题先报：坏插件不该只在 TUI 里可见，headless 用户更需要看到它。
    for (const warning of runtime.plugins.warnings()) process.stderr.write(`${warning}\n`);

    // 优先级：命令行 > 配置文件 > 内置默认。这样 /permission 写回 config 后下次启动仍生效。
    // config.model 是 bootstrap 折叠后的生效模型（--model 整串即 id，--provider 另选提供商）。
    const approvalMode: ApprovalMode = args.approval ?? config.approval ?? 'ask';
    const client = runtime.makeClient({
      model: config.model,
      api: args.api ?? config.api,
      effort: args.effort ?? config.reasoningEffort,
    });
    // 辅助调用（压缩摘要 / auto 审查器）可以走更便宜的模型或另一个厂商的端点；
    // 未配置时 makeAuxClient 返回 undefined，下面各处自动回退主 client。
    const compactClient = runtime.makeAuxClient(config.compactModel);
    const reviewClient = runtime.makeAuxClient(config.reviewModel);
    const recordAuxUsage = (usage: TokenUsage, purpose: string): void => {
      session.appendEvent('usage', { ...usage, purpose });
    };
    // 恢复的会话带着跨轮次状态：任务目标与上次失败要进提示词，否则「继续」时模型是失忆的。
    const folded = runtime.plugins.get<SessionService>(SESSION_SERVICE)?.fold(session.readAll())
      ?? { depth: 0, goal: undefined, failures: [], planMode: false, tokensUsed: 0 };
    const output = args.outputFormat === 'json'
      ? createJsonOutput({ sessionId: session.id })
      : createTextOutput();
    await runtime.driver({
      prompt,
      workspaceRoot,
      client,
      model: config.model,
      session,
      tools: runtime.tools,
      sessions: runtime.sessions,
      sandbox,
      approver: new HeadlessApprover(
        approvalMode,
        approvalMode === 'auto'
          ? createLlmClassifier(reviewClient ?? client, { onUsage: (usage) => recordAuxUsage(usage, 'review') })
          : undefined,
        config.permissions,
      ),
      // strict 子代理：fail-closed，不弹窗也不共享父会话的授权；策略判定在这里，loop 只挑。
      ...(config.subagentApproval === 'strict'
        ? { subagentApprover: new HeadlessApprover('ask', undefined, config.permissions) }
        : {}),
      contextWindow: config.contextWindow,
      depth: folded.depth,
      maxSubagentDepth: config.subagentMaxDepth,
      maxTurns: config.maxTurns,
      maxSessionTokens: config.maxSessionTokens,
      listener: combineListeners(output.listener, runtime.plugins.turnListeners()),
      services: runtime.plugins,
      hooks: runtime.plugins.hooks(),
      todos,
      jobs,
      goal: folded.goal,
      lastFailure: folded.failures.at(-1),
      planMode: { active: folded.planMode },
      reviewPlan: approvalMode === 'yolo'
        ? async () => ({ approved: true })
        : undefined,
      compactClient,
      onAuxUsage: recordAuxUsage,
      spill: runtime.plugins.get<StorageService>(STORAGE_SERVICE)?.open(join(sphSpillRoot(), session.id), config.spillThreshold),
      worktrees: runtime.worktrees,
    });
    process.stdout.write(output.finalLine());
  } finally {
    runtime.cleanup();
  }
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(process.cwd());

  if (args.command === 'sessions') {
    await runSessionsCommand(workspaceRoot, args.search);
    return;
  }
  if (args.command === 'export') {
    await runExportCommand(workspaceRoot, args.sessionId, args.format);
    return;
  }
  if (args.rpc) {
    const runtime = await bootstrap(args, workspaceRoot, 'error');
    if (!runtime) return;
    try {
      const { runRpcLoop } = await import('./rpc.js');
      await runRpcLoop(runtime, {
        model: runtime.config.model,
        api: args.api ?? runtime.config.api,
        effort: args.effort ?? runtime.config.reasoningEffort,
        approval: args.approval ?? runtime.config.approval ?? 'ask',
      });
    } finally {
      runtime.cleanup();
    }
    return;
  }

  // 界面路由：带 -p 走 headless；否则尝试交互模式（非 TTY 时由 runInteractive 报用法退出）。
  if (args.prompt === undefined) {
    await runInteractive(args, workspaceRoot);
    return;
  }
  await runHeadless(args, workspaceRoot, args.prompt);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
