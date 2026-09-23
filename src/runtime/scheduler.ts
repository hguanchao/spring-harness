/**
 * 调度接缝。后台任务板的实现在 sph-schedule，循环、工具和界面只依赖这一面。
 */

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
  /** 完成通知是否已被消费。loop 每步注入与界面唤醒共用这一个标记。 */
  delivered?: boolean;
}

/** 后台子代理收件箱。投递发生在下一步顶部，不打断当前调用。 */
export interface SubagentInbox {
  push(text: string): void;
  drain(): string[];
}

/**
 * 主会话的运行中输入队列。
 * 界面要能看到挂起的内容，也能把一条搬回输入框；drain 语义对循环不变。
 */
export interface SteeringInbox extends SubagentInbox {
  peek(): readonly string[];
  removeLast(): string | undefined;
  full(): boolean;
  move(index: number, delta: -1 | 1): boolean;
  removeAt(index: number): string | undefined;
  insertAt(index: number, text: string): void;
}

/** 挂起队列上限。超过即拒绝，而不是挤掉最旧的一条。 */
export const STEERING_QUEUE_LIMIT = 8;

export type TaskDoneListener = (job: JobRecord) => void;

/**
 * 完成通知的正文。循环注入和界面唤醒共用这一份，避免两边各写一种。
 * 带 session id，模型据此能续接，不必再查 jobs。
 */
export function jobNotificationText(job: JobRecord): string {
  const ok = job.status === 'done' && job.exitCode === 0;
  const body = ok ? job.result || '(no output)' : job.stderr || '(failed with no output)';
  const footer = job.subagentSessionId
    ? `\n\n[subagent session: ${job.subagentSessionId} — continue with subagent(resume_from: "${job.subagentSessionId}")]`
    : '';
  return `[background task ${ok ? 'completed' : 'FAILED'}: ${job.command} — runtime notification, not a user request; do not start this work again unless the result shows it failed]\n${body}${footer}`;
}

/** 替换 sph-schedule 时实现这一面即可。 */
export interface JobBoardPort {
  startTask(label: string, task: (signal: AbortSignal, job: JobRecord) => Promise<string>): string;
  onTaskDone(listener: TaskDoneListener): () => void;
  drainNotifications(): JobRecord[];
  attachInbox(subagentSessionId: string, inbox: SubagentInbox): void;
  detachInbox(subagentSessionId: string): void;
  sendToSubagent(subagentSessionId: string, text: string): 'queued' | 'not_found' | 'completed';
  abortAll(): void;
  list(): JobRecord[];
  get(id: string): JobRecord | undefined;
}
