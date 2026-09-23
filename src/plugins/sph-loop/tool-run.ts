/**
 * 同一步工具调用的调度：连续可并行的调用成批执行，exclusive 做屏障，
 * 结果按模型序提交——完成序不得打乱 JSONL / 提示词前缀（否则缓存命中抖动，
 * 部分网关还会因 call/result 乱序直接 400）。
 */
import { errorMessage } from '../../util.js';
import type { ToolResult } from '../../tools/types.js';

/** 已发出 tool_start 但进程在 dispatch 前被取消：必须仍落一条 result，保证成对。 */
export const ABORTED_BEFORE_DISPATCH = 'interrupted (aborted before dispatch)';

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolBatchOptions {
  calls: readonly ToolCallRequest[];
  /** 缺省应 fail-closed（未知工具走 exclusive）。 */
  isParallel: (name: string) => boolean;
  execute: (call: ToolCallRequest) => Promise<ToolResult>;
  onStart: (call: ToolCallRequest) => void;
  onCommit: (call: ToolCallRequest, result: ToolResult) => void;
  signal?: AbortSignal;
}

/**
 * 按模型序扫描：连续 `isParallel` 的调用 `Promise.all`，遇到 exclusive 先 drain 再串行。
 * `onStart` 在启动（或跳过）时按模型序发出；`onCommit` 只在 `0..k` 连续完成时前进。
 */
export async function runToolBatch(options: ToolBatchOptions): Promise<void> {
  const { calls, isParallel, execute, onStart, onCommit, signal } = options;
  const n = calls.length;
  if (n === 0) return;

  const results: Array<ToolResult | undefined> = Array.from({ length: n });
  let committed = 0;

  const commitReady = (): void => {
    while (committed < n) {
      const result = results[committed];
      if (result === undefined) break;
      onCommit(calls[committed], result);
      committed++;
    }
  };

  const runSafe = async (call: ToolCallRequest): Promise<ToolResult> => {
    try {
      return await execute(call);
    } catch (error) {
      return { ok: false, content: errorMessage(error) };
    }
  };

  const abortRemaining = (from: number): void => {
    for (let i = from; i < n; i++) {
      onStart(calls[i]);
      results[i] = { ok: false, content: ABORTED_BEFORE_DISPATCH };
    }
    commitReady();
  };

  let i = 0;
  while (i < n) {
    if (signal?.aborted) {
      abortRemaining(i);
      return;
    }
    if (!isParallel(calls[i].name)) {
      onStart(calls[i]);
      results[i] = await runSafe(calls[i]);
      commitReady();
      i++;
      continue;
    }
    const started: Promise<void>[] = [];
    while (i < n && isParallel(calls[i].name)) {
      if (signal?.aborted) break;
      const index = i;
      onStart(calls[index]);
      started.push(
        runSafe(calls[index]).then((result) => {
          results[index] = result;
          commitReady();
        }),
      );
      i++;
    }
    await Promise.all(started);
  }
}
