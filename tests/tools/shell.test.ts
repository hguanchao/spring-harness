import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bashTool } from '../../src/plugins/sph-tools/shell.js';
import type { ToolContext } from '../../src/tools/types.js';

function ctx(
  runShell: ToolContext['runShell'],
  startTask?: ToolContext['jobs']['startTask'],
): ToolContext {
  return {
    approve: async () => true,
    runShell,
    jobs: {
      startTask: startTask ?? (() => {
        throw new Error('not background');
      }),
    },
  } as unknown as ToolContext;
}

describe('shell timeout cap', () => {
  it('没写 timeout_ms 时用 60 秒，结果里不提上限', async () => {
    const seen: number[] = [];
    const result = await bashTool.execute({ command: 'true' }, ctx(async (_command, timeoutMs) => {
      seen.push(timeoutMs);
      return { stdout: '', stderr: '', exitCode: 0 };
    }));
    assert.deepEqual(seen, [60_000]);
    assert.equal(result.ok, true);
    assert.equal(result.content.includes('capped'), false);
  });

  it('超过 5 分钟会被缩短，并且结果写明被改过', async () => {
    const seen: number[] = [];
    const result = await bashTool.execute({ command: 'true', timeout_ms: 900_000 }, ctx(async (_command, timeoutMs) => {
      seen.push(timeoutMs);
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    }));
    assert.deepEqual(seen, [300_000]);
    assert.equal(result.ok, true);
    assert.match(result.content, /^timeout_ms 900000 was capped at 300000\nexit 0/);
  });

  it('后台任务的启动回执和完成回执都带同一条上限说明', async () => {
    let ran = 0;
    let done: Promise<string> = Promise.resolve('');
    const result = await bashTool.execute({ command: 'true', timeout_ms: 900_000, background: true }, ctx(
      async (_command, timeoutMs) => {
        ran = timeoutMs;
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      (_label, task) => {
        done = task(new AbortController().signal, {} as never);
        return 'job-1';
      },
    ));
    assert.match(result.content, /^timeout_ms 900000 was capped at 300000\nbackground bash started: job-1/);
    assert.equal(ran, 300_000);
    assert.match(await done, /^timeout_ms 900000 was capped at 300000\nexit 0/);
  });
});
