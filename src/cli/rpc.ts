/**
 * 最小 JSONL RPC：stdin 一行一个命令，stdout 一行一个事件。
 * 只覆盖 prompt / abort / quit，给脚本嵌 sph 用，不是完整 pi RPC。
 */
import { createInterface } from 'node:readline';
import { HeadlessApprover } from '../permission/policy.js';
import { createJsonOutput } from './output.js';
import type { Runtime } from './bootstrap.js';
import { isRecord } from '../util.js';

export async function runRpcLoop(runtime: Runtime, options: {
  model: string;
  api: Runtime['config']['api'];
  effort?: Runtime['config']['reasoningEffort'];
  approval: 'ask' | 'auto' | 'yolo';
}): Promise<void> {
  const { session, sandbox, todos, jobs, config } = runtime;
  const client = runtime.makeClient({
    model: options.model,
    api: options.api,
    effort: options.effort,
  });
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let abort: AbortController | undefined;
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      process.stdout.write(`${JSON.stringify({ type: 'error', text: 'invalid json' })}\n`);
      continue;
    }
    if (!isRecord(parsed) || typeof parsed.type !== 'string') {
      process.stdout.write(`${JSON.stringify({ type: 'error', text: 'missing type' })}\n`);
      continue;
    }
    if (parsed.type === 'quit') break;
    if (parsed.type === 'abort') {
      abort?.abort();
      continue;
    }
    if (parsed.type !== 'prompt' || typeof parsed.message !== 'string') {
      process.stdout.write(`${JSON.stringify({ type: 'error', text: 'expected prompt' })}\n`);
      continue;
    }
    abort = new AbortController();
    const output = createJsonOutput({ sessionId: session.id });
    try {
      await runtime.driver({
        prompt: parsed.message,
        workspaceRoot: runtime.workspaceRoot,
        client,
        model: options.model,
        session,
        tools: runtime.tools,
        sessions: runtime.sessions,
        sandbox,
        approver: new HeadlessApprover(options.approval, undefined, config.permissions),
        contextWindow: config.contextWindow,
        listener: output.listener,
        signal: abort.signal,
        services: runtime.plugins,
        todos,
        jobs,
        worktrees: runtime.worktrees,
      });
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ type: 'error', text: error instanceof Error ? error.message : String(error) })}\n`);
    }
    process.stdout.write(`${output.finalLine()}\n`);
    abort = undefined;
  }
}
