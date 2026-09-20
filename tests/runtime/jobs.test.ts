import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSteeringInbox, STEERING_QUEUE_LIMIT } from '../../src/runtime/jobs.js';

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
