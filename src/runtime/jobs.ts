import { randomUUID } from 'node:crypto';
import { errorMessage } from '../util.js';

export interface JobRecord {
  id: string;
  kind: 'subagent';
  command: string;
  status: 'running' | 'done';
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** 后台 subagent 的最终文本结果。 */
  result?: string;
  /** 后台 subagent 的会话 id：resume_from / send_subagent_message 靠它寻址。 */
  subagentSessionId?: string;
  /** 完成通知是否已被消费（loop 每步注入与 TUI 唤醒共用同一个投递标记）。 */
  delivered?: boolean;
}

/**
 * 后台子代理收件箱：父级（或模型经 send_subagent_message）投递，子代理 loop
 * 在下一步顶部 drain——投递到「下一个安全点」（grok 的 steer 语义），不打断当前调用。
 */
export interface SubagentInbox {
  push(text: string): void;
  drain(): string[];
}

/**
 * 完成通知的正文格式。loop 每步注入与 TUI 唤醒共用同一份文案，避免两边漂移。
 * 带 session id footer：模型据此能 resume 或继续发消息，不必再查 jobs。
 */
export function jobNotificationText(job: JobRecord): string {
  const ok = job.status === 'done' && job.exitCode === 0;
  const body = ok ? job.result || '(no output)' : job.stderr || '(failed with no output)';
  const footer = job.subagentSessionId
    ? `\n\n[subagent session: ${job.subagentSessionId} — continue with subagent(resume_from: "${job.subagentSessionId}")]`
    : '';
  // 说明来源与性质：这条是运行时生成的通知，不是用户发言，也不是待办。
  // 不写清楚，模型会把它当成新指令去执行一遍，或当成用户提问去回答。
  return `[background task ${ok ? 'completed' : 'FAILED'}: ${job.command} — runtime notification, not a user request; do not start this work again unless the result shows it failed]\n${body}${footer}`;
}

type TaskDoneListener = (job: JobRecord) => void;

/**
 * 后台任务与主 loop 脱钩；完成结果以「推送」送达（grok-build 语义）：完成即触发
 * onTaskDone 回调并打上未投递标记，loop 在下一步顶部、TUI 在轮次收尾/空闲时 drain。
 * jobs 工具降级为状态快照，不再是获知完成的必要手段。
 */
export class JobBoard {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly taskController = new AbortController();
  private readonly doneListeners: TaskDoneListener[] = [];
  /** 后台子代理收件箱：session id → inbox。只有仍在跑的子代理会有 inbox。 */
  private readonly inboxes = new Map<string, SubagentInbox>();

  /**
   * 挂起任意异步任务（当前用于后台 subagent）。task 收到自己的 record：子代理
   * 创建会话后要回写 subagentSessionId（供 resume / send 寻址），且必须在首个
   * await 之前完成——record 在 task 启动前已存在，无时序问题。
   * 完成信号与结果写回 record，由调用方决定如何消费；JobBoard 不感知任务内部实现。
   */
  startTask(label: string, task: (signal: AbortSignal, job: JobRecord) => Promise<string>): string {
    const job: JobRecord = {
      id: randomUUID().slice(0, 8),
      kind: 'subagent',
      command: label,
      status: 'running',
      stdout: '',
      stderr: '',
      exitCode: null,
    };
    this.jobs.set(job.id, job);
    const notify = (): void => {
      for (const listener of this.doneListeners) listener(job);
    };
    void task(this.taskController.signal, job)
      .then((result: string) => {
        job.status = 'done';
        job.exitCode = 0;
        job.result = result;
        notify();
      })
      .catch((error: unknown) => {
        job.status = 'done';
        job.exitCode = 1;
        job.stderr = errorMessage(error);
        notify();
      });
    return job.id;
  }

  /** 注册后台任务完成回调：完成即触发，投递时机由消费方 drain 决定。 */
  onTaskDone(listener: TaskDoneListener): () => void {
    this.doneListeners.push(listener);
    return () => {
      const index = this.doneListeners.indexOf(listener);
      if (index !== -1) this.doneListeners.splice(index, 1);
    };
  }

  /**
   * 取走所有已完成且未投递的记录。loop 每步注入与 TUI auto-wake 先到先得，
   * delivered 标记保证同一份结果不会重复注入。
   */
  drainNotifications(): JobRecord[] {
    const out: JobRecord[] = [];
    for (const job of this.jobs.values()) {
      if (job.status === 'done' && !job.delivered) {
        job.delivered = true;
        out.push(job);
      }
    }
    return out;
  }

  /** 后台子代理注册收件箱：仍在跑时父级（或模型经 send 工具）才能投递消息。 */
  attachInbox(subagentSessionId: string, inbox: SubagentInbox): void {
    this.inboxes.set(subagentSessionId, inbox);
  }

  detachInbox(subagentSessionId: string): void {
    this.inboxes.delete(subagentSessionId);
  }

  /**
   * 给子代理投递一条消息。仍在跑 → queued（子代理下一步顶部 drain）；
   * 已完成（record 在且无 inbox）→ completed，调用方引导改用 resume_from；
   * 未知 id → not_found。
   */
  sendToSubagent(subagentSessionId: string, text: string): 'queued' | 'not_found' | 'completed' {
    const inbox = this.inboxes.get(subagentSessionId);
    if (inbox) {
      inbox.push(text);
      return 'queued';
    }
    for (const job of this.jobs.values()) {
      if (job.subagentSessionId === subagentSessionId) return 'completed';
    }
    return 'not_found';
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
