#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runTurn } from '../agent/loop.js';
import type { AgentListener } from '../agent/events.js';
import { HeadlessApprover, type ApprovalMode } from '../approval/policy.js';
import { createLlmClassifier } from '../approval/auto.js';
import { HELP, parseArgs, type CliArgs } from './args.js';
import { CliError, bootstrapRuntime, type Runtime } from './bootstrap.js';
import { runTui } from '../tui/app.js';
import { sessionDirFor } from '../session/path.js';
import { lastAssistantMessage, messagesOf } from '../session/query.js';
import { exportJson, exportMarkdown } from '../session/export.js';
import { JsonlSession, listSessions, type SessionInfo } from '../session/store.js';
import type { SessionRecord } from '../session/types.js';
import { resolveWorkspaceRoot } from '../workspace/root.js';

function printSessionInfos(infos: SessionInfo[]): void {
  for (const info of infos) {
    const when = new Date(info.mtimeMs).toISOString().replace('T', ' ').slice(0, 16);
    const hits = info.hits !== undefined ? ` hits=${info.hits}` : '';
    process.stdout.write(`${info.id}  ${when}  msgs=${info.messages}${hits}  ${info.preview}\n`);
  }
}

/** sessions 子命令：列表或关键词过滤，不进入 agent 运行时。 */
async function runSessionsCommand(workspaceRoot: string, search?: string): Promise<void> {
  const dir = sessionDirFor(workspaceRoot);
  const infos = await listSessions(dir, { search });
  printSessionInfos(infos);
  if (infos.length === 0) process.stdout.write(search ? `no session contains "${search}"\n` : 'no sessions yet\n');
}

async function runExportCommand(workspaceRoot: string, sessionId?: string, format: 'md' | 'json' = 'md'): Promise<void> {
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
  process.stdout.write(format === 'json' ? exportJson(session) : exportMarkdown(session));
}

interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * 聚合 token 用量。入参是已解析的记录而不是 session：
 * 调用方在同一处已经读过一次会话文件，不必为了统计再读一遍（会话可达数 MB）。
 */
function aggregateUsage(records: readonly SessionRecord[]): UsageTotals {
  const totals: UsageTotals = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  for (const record of records) {
    if (record.type !== 'event' || record.kind !== 'usage') continue;
    const prompt = record.data.promptTokens;
    const completion = record.data.completionTokens;
    const total = record.data.totalTokens;
    if (typeof prompt === 'number') totals.promptTokens += prompt;
    if (typeof completion === 'number') totals.completionTokens += completion;
    if (typeof total === 'number') totals.totalTokens += total;
  }
  return totals;
}

/** 统一的装配入口：把 CliError 翻译成 stderr + 退出码，其余异常继续上抛。 */
async function bootstrap(
  args: CliArgs,
  workspaceRoot: string,
  untrusted: 'error' | 'confirm',
): Promise<Runtime | undefined> {
  try {
    return await bootstrapRuntime({
      workspaceRoot,
      sandboxOverride: args.sandbox,
      trust: args.trust,
      untrusted,
      newSession: args.newSession,
      resumeId: args.resumeId,
      fork: args.fork,
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
  if (args.schemaPath !== undefined) {
    process.stderr.write('--schema requires -p/--prompt: it constrains one headless turn\n');
    process.exitCode = 2;
    return;
  }
  if (args.output !== 'text') {
    process.stderr.write(`--output ${args.output} requires -p/--prompt\n`);
    process.exitCode = 2;
    return;
  }
  // 非 TTY（管道 / CI）绝不进 TUI：否则会挂住等按键。
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      'missing -p/--prompt: pass "sph -p <prompt>" for one headless turn, or run in an interactive terminal for the TUI (see: sph --help)\n',
    );
    process.exitCode = 2;
    return;
  }

  const runtime = await bootstrap(args, workspaceRoot, 'confirm');
  if (!runtime) return;
  try {
    for (const warning of runtime.mcpWarnings) process.stderr.write(`${warning}\n`);
    await runTui({
      workspaceRoot,
      sessionDir: runtime.sessionDir,
      contextWindow: runtime.config.contextWindow,
      sandbox: runtime.sandbox,
      session: runtime.session,
      mcp: runtime.mcp,
      mcpServerCount: runtime.config.mcpServers.length,
      todos: runtime.todos,
      jobs: runtime.jobs,
      persistent: runtime.persistent,
      approvalMode: args.approval ?? runtime.config.approval ?? 'ask',
      configPath: runtime.configPath,
      model: args.model ?? runtime.config.model,
      api: args.api ?? runtime.config.api,
      effort: args.effort ?? runtime.config.reasoningEffort,
      makeClient: (overrides) => runtime.makeClient(overrides),
    });
  } finally {
    runtime.cleanup();
  }
}

/** headless 路径：一次 runTurn 后退出。除装配外与旧实现逐行一致。 */
async function runHeadless(args: CliArgs, workspaceRoot: string, prompt: string): Promise<void> {
  const runtime = await bootstrap(args, workspaceRoot, 'error');
  if (!runtime) return;
  const { session, sandbox, mcp, todos, jobs, persistent, config } = runtime;
  try {
    for (const warning of runtime.mcpWarnings) process.stderr.write(`${warning}\n`);

    let finalPrompt = prompt;
    if (args.schemaPath) {
      const schema = readFileSync(args.schemaPath, 'utf8');
      finalPrompt = `${prompt}\n\n[output contract] Your final reply must be a single JSON object conforming to this JSON Schema, with no extra prose:\n${schema}`;
    }
    // 优先级：命令行 > 配置文件 > 内置默认。这样 /approval 写回 config 后下次启动仍生效。
    const approvalMode: ApprovalMode = args.approval ?? config.approval ?? 'ask';
    const client = runtime.makeClient({
      model: args.model ?? config.model,
      api: args.api ?? config.api,
      effort: args.effort ?? config.reasoningEffort,
    });
    const started = Date.now();
    const listener: AgentListener = (event) => {
      if (args.output === 'stream-json') {
        process.stdout.write(`${JSON.stringify(event)}\n`);
        return;
      }
      if (args.output !== 'text') return;
      switch (event.type) {
        case 'text':
          process.stdout.write(event.text);
          break;
        case 'tool_start':
          process.stderr.write(`\n[${event.name}]\n`);
          break;
        case 'tool_end':
          process.stderr.write(`${event.content.slice(0, 400)}\n`);
          break;
        case 'status':
        case 'error':
          process.stderr.write(`${event.text}\n`);
          break;
        default:
          break;
      }
    };
    await runTurn({
      prompt: finalPrompt,
      workspaceRoot,
      client,
      session,
      sandbox,
      approver: new HeadlessApprover(approvalMode, approvalMode === 'auto' ? createLlmClassifier(client) : undefined),
      contextWindow: config.contextWindow,
      listener,
      mcp,
      todos,
      jobs,
      persistent,
    });
    if (args.output === 'text') {
      process.stdout.write('\n');
      return;
    }
    // 一次读盘同时满足「取最终回复」与「聚合用量」：旧实现对同一个数 MB 的 JSONL 读了三次。
    const records = session.readAll();
    const finalText = lastAssistantMessage(messagesOf(records))?.content ?? '';
    let schemaValid: boolean | undefined;
    if (args.schemaPath) {
      try {
        const parsed: unknown = JSON.parse(finalText);
        schemaValid = parsed !== null && typeof parsed === 'object';
      } catch {
        schemaValid = false;
      }
    }
    if (args.output === 'stream-json') {
      process.stdout.write(`${JSON.stringify({ type: 'result', ok: schemaValid !== false, session: session.id })}\n`);
    } else {
      process.stdout.write(`${JSON.stringify({
        ok: schemaValid !== false,
        session: session.id,
        text: finalText,
        usage: aggregateUsage(records),
        durationMs: Date.now() - started,
        schemaValid,
      }, null, 2)}\n`);
    }
    if (schemaValid === false) process.exitCode = 3;
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
