import { randomUUID } from 'node:crypto';
import {
  STEERING_QUEUE_LIMIT,
  type JobBoardPort,
  type JobRecord,
  type SteeringInbox,
  type SubagentInbox,
  type TaskDoneListener,
} from '../../runtime/scheduler.js';
import { errorMessage } from '../../util.js';

export type { JobBoardPort, JobRecord, SteeringInbox, SubagentInbox, TaskDoneListener } from '../../runtime/scheduler.js';
export { STEERING_QUEUE_LIMIT, jobNotificationText } from '../../runtime/scheduler.js';

/** 造一个带查看与搬回能力的运行中输入队列。界面用它；测试注入即可。 */
export function createSteeringInbox(limit = STEERING_QUEUE_LIMIT): SteeringInbox & { full(): boolean } {
  let queue: string[] = [];
  return {
    push(text: string) {
      queue.push(text);
    },
    drain() {
      const all = queue;
      queue = [];
      return all;
    },
    peek() {
      return [...queue];
    },
    removeLast() {
      return queue.pop();
    },
    full() {
      return queue.length >= limit;
    },
    move(index: number, delta: -1 | 1) {
      const to = index + delta;
      if (index < 0 || index >= queue.length || to < 0 || to >= queue.length) return false;
      const moved = queue[index]!;
      queue[index] = queue[to]!;
      queue[to] = moved;
      return true;
    },
    removeAt(index: number) {
      if (index < 0 || index >= queue.length) return undefined;
      return queue.splice(index, 1)[0];
    },
    insertAt(index: number, text: string) {
      queue.splice(Math.max(0, Math.min(index, queue.length)), 0, text);
    },
  };
}

/**
 * 后台任务与主 loop 脱钩；完成结果以「推送」送达：完成即触发
 * onTaskDone 回调并打上未投递标记，loop 在下一步顶部、TUI 在轮次收尾/空闲时 drain。
 * task(action: list|get) 只是状态快照，不再是获知完成的必要手段。
 */
export class JobBoard implements JobBoardPort {
  private readonly jobs = new Map<string, JobRecord>();
  /** 每个任务自己的控制器：abort(id) 精确到达，abortAll 逐个转发。settle 时移除。 */
  private readonly controllers = new Map<string, AbortController>();
  private readonly doneListeners: TaskDoneListener[] = [];
  /** 后台子代理收件箱：session id → inbox。只有仍在跑的子代理会有 inbox。 */
  private readonly inboxes = new Map<string, SubagentInbox>();

  /**
   * 挂起任意异步任务（当前用于后台 subagent）。task 收到自己的 record：子代理
   * 创建会话后要回写 subagentSessionId（供 resume / send 寻址），且必须在首个
   * await 之前完成——record 在 task 启动前已存在，无时序问题。
   * 完成信号与结果写回 record，由调用方决定如何消费；JobBoard 不感知任务内部实现。
   */
  startTask(
    label: string,
    task: (signal: AbortSignal, job: JobRecord) => Promise<string>,
    kind: JobRecord['kind'] = 'subagent',
  ): string {
    const job: JobRecord = {
      id: randomUUID().slice(0, 8),
      kind,
      command: label,
      status: 'running',
      stdout: '',
      stderr: '',
      exitCode: null,
    };
    this.jobs.set(job.id, job);
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    const notify = (): void => {
      for (const listener of this.doneListeners) listener(job);
    };
    void task(controller.signal, job)
      .then((result: string) => {
        this.controllers.delete(job.id);
        job.status = 'done';
        job.exitCode = 0;
        job.result = result;
        notify();
      })
      .catch((error: unknown) => {
        this.controllers.delete(job.id);
        // abort 触发的失败不是错误：状态改判为 cancelled，通知文案随之走 CANCELLED 分支。
        job.status = controller.signal.aborted ? 'cancelled' : 'done';
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
   * 取走所有已结束且未投递的记录。loop 每步注入与 TUI auto-wake 先到先得，
   * delivered 标记保证同一份结果不会重复注入。取消也是终态：cancelled 同样要投递，
   * 否则父代理永远不知道任务为什么没等到结果。
   */
  drainNotifications(): JobRecord[] {
    const out: JobRecord[] = [];
    for (const job of this.jobs.values()) {
      if (job.status !== 'running' && !job.delivered) {
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

  /**
   * 取消指定任务。只发信号就返回——任务在下一个安全点（子代理是 runTurn 的
   * 步边界或工具派发点）退出，状态改判和通知都发生在 settle 路径上，保证
   * 「一条通知对应一次真实停止」。任务若不检查 signal，状态停留在 running：
   * 与 abortAll 同一契约，不强杀。
   */
  abort(id: string): 'cancelled' | 'not_found' | 'done' {
    const job = this.jobs.get(id);
    if (!job) return 'not_found';
    if (job.status !== 'running') return 'done';
    this.controllers.get(id)?.abort();
    return 'cancelled';
  }

  /** 进程退出路径调用：后台任务全部放弃。 */
  abortAll(): void {
    for (const controller of this.controllers.values()) controller.abort();
  }

  list(): JobRecord[] {
    return [...this.jobs.values()];
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }
}
