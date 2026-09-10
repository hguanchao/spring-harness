import { randomUUID } from 'node:crypto';
import type { SandboxHandle, SpawnResult } from '../sandbox/open.js';

export interface JobRecord {
  id: string;
  kind: 'shell' | 'subagent';
  command: string;
  status: 'running' | 'done';
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** subagent job 的最终文本结果；shell job 为空。 */
  result?: string;
}

/** 后台命令与主 loop 脱钩；模型用 jobs 轮询，不把长任务堵在一轮里。 */
export class JobBoard {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly taskController = new AbortController();

  constructor(private readonly sandbox: SandboxHandle) {}

  start(command: string, argv: { command: string; args: string[]; cwd: string }): string {
    const id = randomUUID().slice(0, 8);
    const job: JobRecord = { id, kind: 'shell', command, status: 'running', stdout: '', stderr: '', exitCode: null };
    this.jobs.set(id, job);
    void this.sandbox.run({
      command: argv.command,
      args: argv.args,
      cwd: argv.cwd,
      timeoutMs: 10 * 60_000,
    }).then((result: SpawnResult) => {
      job.status = 'done';
      job.stdout = result.stdout;
      job.stderr = result.stderr;
      job.exitCode = result.exitCode;
    }).catch((error: unknown) => {
      job.status = 'done';
      job.stderr = error instanceof Error ? error.message : String(error);
      job.exitCode = 1;
    });
    return id;
  }

  /**
   * 挂起任意异步任务（当前用于后台 subagent）。完成信号与结果写回 record，
   * 由调用方决定如何消费；JobBoard 不感知任务内部实现。
   */
  startTask(label: string, task: (signal: AbortSignal) => Promise<string>): string {
    const id = randomUUID().slice(0, 8);
    const job: JobRecord = { id, kind: 'subagent', command: label, status: 'running', stdout: '', stderr: '', exitCode: null };
    this.jobs.set(id, job);
    void task(this.taskController.signal)
      .then((result: string) => {
        job.status = 'done';
        job.exitCode = 0;
        job.result = result;
      })
      .catch((error: unknown) => {
        job.status = 'done';
        job.exitCode = 1;
        job.stderr = error instanceof Error ? error.message : String(error);
      });
    return id;
  }

  /** 进程退出路径调用：后台任务全部放弃。 */
  abortAll(): void {
    this.taskController.abort();
  }

  list(): JobRecord[] {
    return [...this.jobs.values()];
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }
}
