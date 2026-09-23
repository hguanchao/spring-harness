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
import { sphModelsPath, sphSpillRoot } from '../home.js';
import type { TokenUsage } from '../llm/client.js';
import { SESSION_SERVICE, STORAGE_SERVICE, UI_SERVICE, type SessionService, type StorageService, type UiService } from '../plugins/services.js';
// 注意：TUI 模块**不要**在顶层 import。它（连同 marked）约 300ms 的加载
// 成本只有交互路径才值得付；--help / sessions / export / -p 全都不需要它。
// 下面两处按需动态 import。
import { sessionService } from '../plugins/sph-session/index.js';
import type { SessionInfo } from '../plugins/services.js';
import { resolveWorkspaceRoot } from '../workspace/root.js';

function printSessionInfos(infos: SessionInfo[]): void {
  for (const info of infos) {
    const when = new Date(info.mtimeMs).toISOString().replace('T', ' ').slice(0, 16);
    const hits = info.hits !== undefined ? ` hits=${info.hits}` : '';
    // 子代理会话数是主会话才有的信息：它那些 subagent 块各自是一个独立文件。
    const subs = info.subagents > 0 ? ` subs=${info.subagents}` : '';
    process.stdout.write(`${info.id}  ${when}  msgs=${info.messages}${subs}${hits}  ${info.preview}\n`);
  }
}

/** sessions 子命令：列出本工作区的主会话（或按关键词过滤），不进入 agent 运行时。 */
async function runSessionsCommand(workspaceRoot: string, search?: string): Promise<void> {
  const dir = sessionService.sessionDirFor(workspaceRoot);
  const infos = await sessionService.list(dir, { search });
  printSessionInfos(infos);
  if (infos.length === 0) process.stdout.write(search ? `no session contains "${search}"\n` : 'no sessions yet\n');
}

async function runExportCommand(workspaceRoot: string, sessionId?: string, format: 'md' | 'json' | 'html' = 'md'): Promise<void> {
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
    await screen.run(runtime, args);
  } finally {
    runtime?.cleanup();
    // 装配失败写在替代屏幕里会被 1049l 清掉，退屏后再打到普通终端。
    if (deferredError !== undefined) process.stderr.write(`${deferredError}\n`);
  }
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
    // config.model 是 bootstrap 折叠后的生效模型（--model 的 provider/id 限定已在此解析）。
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
      ?? { depth: 0, failures: [], planMode: false };
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
      maxSessionTokens: config.maxSessionTokens,
      listener: output.listener,
      services: runtime.plugins,
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
