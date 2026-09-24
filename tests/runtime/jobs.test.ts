import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSteeringInbox, JobBoard, STEERING_QUEUE_LIMIT } from '../../src/plugins/sph-schedule/jobs.js';
import { jobNotificationText } from '../../src/runtime/scheduler.js';

describe('后台 shell', () => {
  it('完成后走和子代理同一条通知，没有会话号', async () => {
    const board = new JobBoard();
    const id = board.startTask('bash: echo hi', async () => 'exit 0\nstdout:\nhi', 'shell');
    const listed = board.list();
    assert.equal(listed[0]?.kind, 'shell');
    assert.equal(listed[0]?.id, id);
    await new Promise((resolve) => setImmediate(resolve));
    const done = board.drainNotifications();
    assert.equal(done.length, 1);
    assert.equal(done[0]?.exitCode, 0);
    const text = jobNotificationText(done[0]!);
    assert.match(text, /background task completed: bash: echo hi/);
    assert.equal(text.includes('resume_from'), false);
    assert.equal(board.drainNotifications().length, 0);
  });
});

describe('按 id 取消', () => {
  /**
   * 在 signal 触发后退出的任务：与 runTurn 的安全点同款契约——观察 signal，
   * 触发即失败。abort 事件是同步派发的，settle 只需冲刷微任务，无计时竞态。
   */
  function startStoppableTask(board: JobBoard, label: string, onJob?: (job: { subagentSessionId?: string }) => void): string {
    return board.startTask(label, async (signal, job) => {
      onJob?.(job);
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      return 'unreachable';
    });
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }

  it('abort 发信号即返回 cancelled；任务停下后状态改判，通知走 CANCELLED 分支', async () => {
    const board = new JobBoard();
    const id = startStoppableTask(board, 'explore 长任务');
    await settle();
    assert.equal(board.get(id)?.status, 'running');
    assert.equal(board.abort(id), 'cancelled');
    // settle 前状态不动：一条通知对应一次真实停止，而不是信号发出那一刻。
    assert.equal(board.get(id)?.status, 'running');
    await settle();
    const job = board.get(id);
    assert.equal(job?.status, 'cancelled');
    const notifications = board.drainNotifications();
    assert.equal(notifications.length, 1);
    const text = jobNotificationText(notifications[0]!);
    assert.match(text, /background task CANCELLED: explore 长任务/);
    assert.equal(text.includes('resume_from'), false, '没有会话号就没有续接尾注');
  });

  it('取消通知保留子代理会话号：部分成果仍可 resume_from 捡回', async () => {
    const board = new JobBoard();
    const id = startStoppableTask(board, '调研任务', (job) => {
      job.subagentSessionId = 'sub-abc123';
    });
    await settle();
    assert.equal(board.abort(id), 'cancelled');
    await settle();
    const notifications = board.drainNotifications();
    assert.equal(notifications.length, 1);
    const text = jobNotificationText(notifications[0]!);
    assert.match(text, /background task CANCELLED: 调研任务/);
    assert.match(text, /task\(resume_from: "sub-abc123"\)/);
  });

  it('未知 id 返回 not_found，已完成返回 done，都不再发信号', async () => {
    const board = new JobBoard();
    assert.equal(board.abort('nope'), 'not_found');
    const id = board.startTask('秒完任务', async () => 'ok');
    await settle();
    assert.equal(board.get(id)?.status, 'done');
    assert.equal(board.abort(id), 'done');
    assert.equal(board.drainNotifications().length, 1, '完成通知只有完成那一条');
  });

  it('abortAll 逐个转发：所有仍在跑的任务都收到信号', async () => {
    const board = new JobBoard();
    const a = startStoppableTask(board, '任务A');
    const b = startStoppableTask(board, '任务B');
    await settle();
    board.abortAll();
    await settle();
    assert.equal(board.get(a)?.status, 'cancelled');
    assert.equal(board.get(b)?.status, 'cancelled');
    assert.equal(board.drainNotifications().length, 2);
  });
});

describe('createSteeringInbox', () => {
  it('push/drain 保持 SubagentInbox 语义：drain 全量取出并清空', () => {
    const inbox = createSteeringInbox();
    inbox.push('a');
    inbox.push('b');
    assert.deepEqual(inbox.drain(), ['a', 'b']);
    assert.deepEqual(inbox.drain(), [], 'drain 后队列清空');
  });

  it('peek 只读不消费：drain 前后内容一致', () => {
    const inbox = createSteeringInbox();
    inbox.push('a');
    inbox.push('b');
    assert.deepEqual(inbox.peek(), ['a', 'b']);
    assert.deepEqual(inbox.peek(), ['a', 'b'], 'peek 是纯读');
    assert.deepEqual(inbox.drain(), ['a', 'b']);
  });

  it('removeLast 搬回最后一条（编辑用）；队列空返回 undefined', () => {
    const inbox = createSteeringInbox();
    assert.equal(inbox.removeLast(), undefined);
    inbox.push('a');
    inbox.push('b');
    assert.equal(inbox.removeLast(), 'b');
    assert.deepEqual(inbox.peek(), ['a']);
  });

  it('full 达到上限即真，push 超限的拒绝由调用方负责', () => {
    const inbox = createSteeringInbox(2);
    assert.equal(inbox.full(), false);
    inbox.push('a');
    assert.equal(inbox.full(), false);
    inbox.push('b');
    assert.equal(inbox.full(), true, '达到上限后 full 为真');
  });

  it('默认上限是 STEERING_QUEUE_LIMIT', () => {
    const inbox = createSteeringInbox();
    for (let i = 0; i < STEERING_QUEUE_LIMIT; i++) inbox.push(`m${i}`);
    assert.equal(inbox.full(), true);
    assert.equal(inbox.peek().length, STEERING_QUEUE_LIMIT);
  });

  it('move 与相邻项交换：越界不动并返回 false', () => {
    const inbox = createSteeringInbox();
    inbox.push('a');
    inbox.push('b');
    inbox.push('c');
    assert.equal(inbox.move(2, 1), false, '尾部不能再下移');
    assert.equal(inbox.move(0, -1), false, '顶部不能再上移');
    assert.equal(inbox.move(1, -1), true);
    assert.deepEqual(inbox.peek(), ['b', 'a', 'c']);
    assert.equal(inbox.move(0, 1), true);
    assert.deepEqual(inbox.peek(), ['a', 'b', 'c']);
  });

  it('removeAt 取走指定位置；越界返回 undefined', () => {
    const inbox = createSteeringInbox();
    assert.equal(inbox.removeAt(0), undefined);
    inbox.push('a');
    inbox.push('b');
    inbox.push('c');
    assert.equal(inbox.removeAt(1), 'b');
    assert.deepEqual(inbox.peek(), ['a', 'c']);
  });

  it('insertAt 回填原排序位：越界收敛为尾部追加', () => {
    const inbox = createSteeringInbox();
    inbox.push('a');
    inbox.push('c');
    inbox.insertAt(1, 'b');
    assert.deepEqual(inbox.peek(), ['a', 'b', 'c']);
    inbox.insertAt(99, 'd');
    assert.deepEqual(inbox.peek(), ['a', 'b', 'c', 'd'], '位置已失效时收敛为追加');
    inbox.insertAt(-1, 'head');
    assert.deepEqual(inbox.peek(), ['head', 'a', 'b', 'c', 'd'], '负下标收敛为插到队首');
  });
});
