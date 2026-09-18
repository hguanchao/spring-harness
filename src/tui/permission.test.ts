import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InteractiveApprover, type ApprovalUi } from './permission.js';
import type { ApprovalMode, ApprovalRequest } from '../permission/policy.js';
import type { GrantStore } from '../permission/store.js';

/** 记录每次弹窗；answers 依次决定用户的选择，用尽后一律拒绝。 */
function fakeUi(mode: ApprovalMode, answers: boolean[] = []): ApprovalUi & { asked: ApprovalRequest[] } {
  const asked: ApprovalRequest[] = [];
  return {
    asked,
    approvalMode: () => mode,
    requestApproval: async (request) => {
      asked.push(request);
      return answers.shift() ?? false;
    },
    requestAnswer: async () => '',
  };
}

/** 内存版授权存储，替代磁盘文件。 */
function fakeStore(initial: string[] = []): GrantStore {
  const keys = new Set(initial);
  return {
    scope: '/ws',
    load: () => [...keys],
    add: (key: string) => {
      keys.add(key);
    },
  };
}

describe('InteractiveApprover 的会话内授权粒度', () => {
  it('对一条命令选「总是允许」，不连带放行同一工具的其他命令', async () => {
    const ui = fakeUi('ask', [true]);
    const approver = new InteractiveApprover(ui);

    // 用户批准了 npm test 并选了「总是允许」。
    assert.equal(await approver.decide({ tool: 'bash', command: 'npm test' }), true);
    approver.allowForSession({ tool: 'bash', command: 'npm test' });
    assert.equal(ui.asked.length, 1);

    // 同一条命令不再问。
    assert.equal(await approver.decide({ tool: 'bash', command: 'npm test' }), true);
    assert.equal(ui.asked.length, 1, '已授权的命令不该重复问');

    // 另一条命令必须重新征求同意。修复前键是工具名，这里会被静默放行。
    assert.equal(await approver.decide({ tool: 'bash', command: 'rm -rf /' }), false);
    assert.equal(ui.asked.length, 2, '换一条命令必须重新问');
  });

  it('escalate 的「总是允许」真的生效（此前记了却从不查询）', async () => {
    const ui = fakeUi('ask', [true]);
    const approver = new InteractiveApprover(ui);

    assert.equal(await approver.decide({ tool: 'escalate', path: '/ws/a.txt' }), true);
    approver.allowForSession({ tool: 'escalate', path: '/ws/a.txt' });
    assert.equal(await approver.decide({ tool: 'escalate', path: '/ws/a.txt' }), true);
    assert.equal(ui.asked.length, 1, '已授权的路径不该重复问');

    assert.equal(await approver.decide({ tool: 'escalate', path: '/ws/b.txt' }), false);
    assert.equal(ui.asked.length, 2, '换一个路径必须重新问');
  });

  it('auto 档审查器否决时升级到人审，不静默放行也不静默拒绝', async () => {
    const ui = fakeUi('auto', [true]);
    const approver = new InteractiveApprover(ui, async () => ({ allowed: false, reason: 'looks destructive' }));

    assert.equal(await approver.decide({ tool: 'bash', command: 'rm -rf /' }), true);
    assert.equal(ui.asked.length, 1, '审查器否决后应交给人判断');
  });

  it('yolo 档下非受审工具照常放行、受审工具也不问', async () => {
    const ui = fakeUi('yolo');
    const approver = new InteractiveApprover(ui);

    assert.equal(await approver.decide({ tool: 'bash', command: 'rm -rf /' }), true);
    assert.equal(await approver.decide({ tool: 'read', path: '/ws/a.txt' }), true);
    assert.equal(ui.asked.length, 0);
  });

  it('「本项目」的授权落盘：换一个实例（＝换一次会话）仍然生效', async () => {
    const grants = fakeStore();
    const first = new InteractiveApprover(fakeUi('ask'), undefined, grants);
    first.allowForProject({ tool: 'bash', command: 'npm test' });

    // 新实例 = 新会话：构造时从存储读回授权。
    const second = new InteractiveApprover(fakeUi('ask'), undefined, grants);
    assert.equal(await second.decide({ tool: 'bash', command: 'npm test' }), true, '跨会话应直接放行');
    assert.equal(
      await second.decide({ tool: 'bash', command: 'rm -rf /' }),
      false,
      '同工具的其他命令不受影响',
    );
  });

  it('「本会话」的授权不落盘：新会话必须重新问', async () => {
    const grants = fakeStore();
    const first = new InteractiveApprover(fakeUi('ask'), undefined, grants);
    first.allowForSession({ tool: 'bash', command: 'npm test' });
    assert.equal(await first.decide({ tool: 'bash', command: 'npm test' }), true);

    const second = new InteractiveApprover(fakeUi('ask'), undefined, grants);
    assert.equal(
      await second.decide({ tool: 'bash', command: 'npm test' }),
      false,
      '本会话授权不该跨会话生效',
    );
  });

  it('没有存储时（headless / 单测）不落盘，只保留本会话授权', async () => {
    const approver = new InteractiveApprover(fakeUi('ask'));
    approver.allowForProject({ tool: 'bash', command: 'npm test' });
    assert.equal(await approver.decide({ tool: 'bash', command: 'npm test' }), true);
  });
});

describe('InteractiveApprover 与 [permissions] 规则', () => {
  it('deny 是硬边界：压过 yolo，也压过已批准的授权，且不弹窗', async () => {
    const ui = fakeUi('yolo');
    const grants = fakeStore();
    const approver = new InteractiveApprover(ui, undefined, grants, {
      allow: [],
      ask: [],
      deny: ['bash:rm -rf*'],
    });
    approver.allowForProject({ tool: 'bash', command: 'rm -rf /' });

    assert.equal(await approver.decide({ tool: 'bash', command: 'rm -rf /' }), false);
    assert.equal(ui.asked.length, 0, '硬边界不该弹窗征求同意——没有「再问一次」这个选项');
  });

  it('ask 规则在 yolo 下仍然强制弹窗', async () => {
    const ui = fakeUi('yolo', [true]);
    const approver = new InteractiveApprover(ui, undefined, undefined, {
      allow: [],
      ask: ['bash:git push*'],
      deny: [],
    });
    assert.equal(await approver.decide({ tool: 'bash', command: 'git push origin main' }), true);
    assert.equal(ui.asked.length, 1, '用户明确写了「这个必须先问我」，比一次模式切换更具体');
  });

  it('allow 规则直接放行，不问也不看模式', async () => {
    const ui = fakeUi('ask');
    const approver = new InteractiveApprover(ui, undefined, undefined, {
      allow: ['bash:npm test'],
      ask: [],
      deny: [],
    });
    assert.equal(await approver.decide({ tool: 'bash', command: 'npm test' }), true);
    assert.equal(ui.asked.length, 0);
  });
});
