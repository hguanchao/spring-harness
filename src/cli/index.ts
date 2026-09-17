#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { createJsonOutput, createTextOutput } from './output.js';
import { HeadlessApprover, type ApprovalMode } from '../approval/policy.js';
import { createLlmClassifier } from '../approval/auto.js';
import { HELP, parseArgs, type CliArgs } from './args.js';
import { CliError, bootstrapRuntime, type Runtime } from './bootstrap.js';
import { sphModelsPath, sphSpillRoot } from '../home.js';
import { SpillStore } from '../runtime/spill.js';
import type { TokenUsage } from '../llm/openai.js';
// 注意：TUI 模块**不要**在顶层 import。它（连同 marked）约 300ms 的加载
// 成本只有交互路径才值得付；--help / sessions / export / -p 全都不需要它。
// 下面两处按需动态 import。
import { sessionDirFor } from '../session/path.js';
import { foldSessionState } from '../session/fold.js';
import { exportHtml, exportJson, exportMarkdown } from '../session/export.js';
import { JsonlSession, listSessions, type SessionInfo } from '../session/store.js';
import { resolveWorkspaceRoot } from '../workspace/root.js';
import { isWorkspaceTrusted, rememberTrustedWorkspace } from '../workspace/trust.js';
import { listAvailableModels } from '../llm/models.js';

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
  const dir = sessionDirFor(workspaceRoot);
  const infos = await listSessions(dir, { search });
  printSessionInfos(infos);
  if (infos.length === 0) process.stdout.write(search ? `no session contains "${search}"\n` : 'no sessions yet\n');
}

async function runExportCommand(workspaceRoot: string, sessionId?: string, format: 'md' | 'json' | 'html' = 'md'): Promise<void> {
  const dir = sessionDirFor(workspaceRoot);
  // export 是只读命令：不创建会话，没有可导出内容时报错退出。
  let id = sessionId;
  if (!id) {
    const infos = await listSessions(dir);
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
  const session = new JsonlSession(dir, id);
  const body = format === 'json' ? exportJson(session) : format === 'html' ? exportHtml(session) : exportMarkdown(session);
  process.stdout.write(body);
}

/** 统一的装配入口：把 CliError 翻译成 stderr + 退出码，其余异常继续上抛。 */
async function bootstrap(
  args: CliArgs,
  workspaceRoot: string,
  untrusted: 'error' | 'confirm',
  confirmUntrustedWorkspace?: (workspaceRoot: string) => Promise<boolean>,
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
      process.stderr.write(`${error.message}\n`);
      process.exitCode = error.exitCode;
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

  // 到这一步确定要进 TUI，才付加载成本。
  const { runTui, confirmWorkspaceTrust, TuiAltScreen, ProcessTerminal } = await import('../tui/index.js');

  // 未信任时先 start 替代屏幕画信任页；主界面接手同一块屏，中间不退。
  let ui: InstanceType<typeof TuiAltScreen> | undefined;
  let runtime: Runtime | undefined;
  try {
    const needsTrustUi = !args.trust && !isWorkspaceTrusted(workspaceRoot);
    if (needsTrustUi) {
      ui = new TuiAltScreen(new ProcessTerminal(), false, workspaceRoot);
      const decision = confirmWorkspaceTrust(workspaceRoot, ui);
      ui.start();
      if (!(await decision)) {
        process.exitCode = 2;
        return;
      }
      rememberTrustedWorkspace(workspaceRoot);
    }

    runtime = await bootstrap(args, workspaceRoot, 'error');
    if (!runtime) return;
    const rt = runtime;
    await runTui({
      workspaceRoot,
      sessionDir: rt.sessionDir,
      contextWindow: rt.config.contextWindow,
      sandbox: rt.sandbox,
      session: rt.session,
      mcp: rt.mcp,
      reloadMcp: () => rt.reloadMcp(),
      refreshMcpPreferences: () => rt.refreshMcpPreferences(),
      mcpPreferences: rt.mcpPreferences,
      mcpSources: () => rt.mcpSources,
      todos: rt.todos,
      jobs: rt.jobs,
      approvalMode: args.approval ?? rt.config.approval ?? 'ask',
      configPath: rt.configPath,
      authLabel: rt.config.apiKey === '' ? 'Logged in with HTTP headers' : 'Logged in with API key',
      baseUrl: rt.config.baseUrl,
      model: args.model ?? rt.config.model,
      api: args.api ?? rt.config.api,
      effort: args.effort ?? rt.config.reasoningEffort,
      maxTokens: args.maxTokens ?? rt.config.maxTokens,
      makeClient: (overrides) => rt.makeClient(overrides),
      makeAuxClient: (model) => rt.makeAuxClient(model),
      fetchModels: () => listAvailableModels(rt.config.baseUrl, rt.config.apiKey, { headers: rt.config.httpHeaders }),
      // 模型目录缓存放用户主目录：/model 靠它在启动时直接命中，不必现等上游一个 RTT。
      modelCachePath: sphModelsPath(),
      // --model 是本次进程的显式选择，不该被会话里记录的模型覆盖；切换会话时仍然尊重会话记录。
      modelPinned: args.model !== undefined,
      compactModel: rt.config.compactModel,
      reviewModel: rt.config.reviewModel,
      spillRoot: sphSpillRoot(),
      spillThreshold: rt.config.spillThreshold,
      maxSubagentDepth: rt.config.subagentMaxDepth,
      maxSessionTokens: rt.config.maxSessionTokens,
      worktrees: rt.worktrees,
      tools: rt.tools,
      sessions: rt.sessions,
      driver: rt.driver,
      claimSession: (id) => rt.claimSession(id),
      mcpWarnings: rt.mcpWarnings,
      ...(ui === undefined ? {} : { ui }),
    });
  } finally {
    ui?.stop({ preserveScreen: true });
    runtime?.cleanup();
  }
}

/** headless 路径：一次 runTurn 后退出。除装配外与旧实现逐行一致。 */
async function runHeadless(args: CliArgs, workspaceRoot: string, prompt: string): Promise<void> {
  const runtime = await bootstrap(args, workspaceRoot, 'error');
  if (!runtime) return;
  const { session, sandbox, mcp, todos, jobs, config } = runtime;
  try {
    for (const warning of runtime.mcpWarnings) process.stderr.write(`${warning}\n`);

    // 优先级：命令行 > 配置文件 > 内置默认。这样 /approval 写回 config 后下次启动仍生效。
    const approvalMode: ApprovalMode = args.approval ?? config.approval ?? 'ask';
    const client = runtime.makeClient({
      model: args.model ?? config.model,
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
    const folded = foldSessionState(session.readAll());
    const output = args.outputFormat === 'json'
      ? createJsonOutput({ sessionId: session.id })
      : createTextOutput();
    await runtime.driver({
      prompt,
      workspaceRoot,
      client,
      model: args.model ?? config.model,
      session,
      tools: runtime.tools,
      sessions: runtime.sessions,
      sandbox,
      approver: new HeadlessApprover(
        approvalMode,
        approvalMode === 'auto'
          ? createLlmClassifier(reviewClient ?? client, { onUsage: (usage) => recordAuxUsage(usage, 'review') })
          : undefined,
      ),
      contextWindow: config.contextWindow,
      depth: folded.depth,
      maxSubagentDepth: config.subagentMaxDepth,
      maxSessionTokens: config.maxSessionTokens,
      listener: output.listener,
      mcp,
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
      spill: new SpillStore(join(sphSpillRoot(), session.id), config.spillThreshold),
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
        model: args.model ?? runtime.config.model,
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
