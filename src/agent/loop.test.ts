import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runTurn } from './loop.js';
import { JsonlSession } from '../session/store.js';
import type { AgentEvent } from './events.js';
import type { ChatMessage, LlmClient, StreamDelta, TokenUsage } from '../llm/openai.js';
import type { SandboxHandle } from '../sandbox/open.js';
import type { Approver } from '../approval/policy.js';

const sandbox: SandboxHandle = {
  status: { mode: 'off', enforcement: 'none', platform: process.platform },
  tempDir: '',
  run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  dispose() {},
};

const approver: Approver = { decide: async () => true };

/**
 * 第一次调用返回工具调用、第二次收尾。
 *
 * 预算检查发生在**步首**，所以单步就收尾的轮次根本不经过它——必须逼出第二步才测得到。
 */
function toolOnceClient(count: { calls: number }): LlmClient {
  const usage = { promptTokens: 60, completionTokens: 40, totalTokens: 100 };
  return {
    async complete(): Promise<StreamDelta> {
      count.calls++;
      if (count.calls === 1) {
        return {
          text: '',
          finishReason: 'tool-calls',
          toolCalls: [{ id: 'c1', name: 'glob', arguments: '{"pattern":"*.zzz"}' }],
          usage,
        };
      }
      return { text: 'done', finishReason: 'stop', usage };
    },
  };
}

function makeSession(): { session: JsonlSession; root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'sph-loop-'));
  return { session: new JsonlSession(root, 'test'), root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('会话 token 预算', () => {
  it('超预算时在发起下一次调用之前中止，并先给出 80% 提醒', async () => {
    const { session, root, cleanup } = makeSession();
    const count = { calls: 0 };
    const events: AgentEvent[] = [];
    try {
      await assert.rejects(
        () =>
          runTurn({
            prompt: 'hi',
            workspaceRoot: root,
            client: toolOnceClient(count),
            session,
            sandbox,
            approver,
            contextWindow: 100_000,
            listener: (event) => events.push(event),
            maxSessionTokens: 100,
          }),
        /token budget exhausted/,
      );
      assert.equal(count.calls, 1, '已经花掉的换不回，但第二次请求不该发出');
      // 第一步就用掉了 100/100，越过 80% 线，所以提醒必须在扣费当时发出。
      assert.ok(
        events.some((event) => event.type === 'status' && /budget \d+% used \(100\/100\)/.test(event.text)),
        `超限之前应当先提醒一次，好让这轮收尾；实际事件：${events.map((event) => event.type).join(',')}`,
      );
    } finally {
      cleanup();
    }
  });

  it('预算为 0 时不限制，轮次正常走完', async () => {
    const { session, root, cleanup } = makeSession();
    const count = { calls: 0 };
    const events: AgentEvent[] = [];
    try {
      await runTurn({
        prompt: 'hi',
        workspaceRoot: root,
        client: toolOnceClient(count),
        session,
        sandbox,
        approver,
        contextWindow: 100_000,
        listener: (event) => events.push(event),
        maxSessionTokens: 0,
      });
      assert.equal(count.calls, 2);
      assert.ok(events.some((event) => event.type === 'done'));
      assert.equal(events.some((event) => event.type === 'status' && /budget/.test(event.text)), false);
    } finally {
      cleanup();
    }
  });

  it('未超预算时既不中止也不提醒', async () => {
    const { session, root, cleanup } = makeSession();
    const count = { calls: 0 };
    const events: AgentEvent[] = [];
    try {
      await runTurn({
        prompt: 'hi',
        workspaceRoot: root,
        client: toolOnceClient(count),
        session,
        sandbox,
        approver,
        contextWindow: 100_000,
        listener: (event) => events.push(event),
        maxSessionTokens: 10_000,
      });
      assert.equal(count.calls, 2, '200 远低于 10000，两步都该跑完');
      assert.equal(events.some((event) => event.type === 'status' && /budget/.test(event.text)), false);
    } finally {
      cleanup();
    }
  });

  it('累计量从会话记录折叠而来：历史用量已经超预算时一次请求都不发', async () => {
    const { session, root, cleanup } = makeSession();
    const count = { calls: 0 };
    try {
      // 模拟上一次会话已经烧掉的量：预算必须活过 resume，否则重启就白烧一遍。
      session.appendEvent('usage', { promptTokens: 90, completionTokens: 10, totalTokens: 100 });
      await assert.rejects(
        () =>
          runTurn({
            prompt: 'hi',
            workspaceRoot: root,
            client: toolOnceClient(count),
            session,
            sandbox,
            approver,
            contextWindow: 100_000,
            maxSessionTokens: 100,
          }),
        /token budget exhausted/,
      );
      assert.equal(count.calls, 0);
    } finally {
      cleanup();
    }
  });
});

/**
 * 两步轮次：第一步返回工具调用、第二步收尾，两轮的 usage 由调用方给定。
 * 未命中提示靠的就是这两份数字的差值，所以必须能分别指定。
 */
function cacheClient(first: TokenUsage, second: TokenUsage): LlmClient {
  let calls = 0;
  return {
    async complete(): Promise<StreamDelta> {
      calls += 1;
      if (calls === 1) {
        return {
          text: '',
          finishReason: 'tool-calls',
          toolCalls: [{ id: 'c1', name: 'glob', arguments: '{"pattern":"*.zzz"}' }],
          usage: first,
        };
      }
      return { text: 'done', finishReason: 'stop', usage: second };
    },
  };
}

function usage(promptTokens: number, cachedTokens?: number): TokenUsage {
  return {
    promptTokens,
    completionTokens: 10,
    totalTokens: promptTokens + 10,
    ...(cachedTokens === undefined ? {} : { cachedTokens }),
  };
}

describe('提示缓存未命中记录', () => {
  /** 从会话记录里找出 cache_miss 事件；`describeCacheMiss` 的全文存在 data.text。 */
  const missEvents = (session: JsonlSession): Array<Record<string, unknown>> =>
    session.readAll().flatMap((record) =>
      record.type === 'event' && record.kind === 'cache_miss' ? [record.data as Record<string, unknown>] : [],
    );

  it('整段未命中时，落一条会话事件（含被重算的 token 数），不进界面事件流', async () => {
    const { session, root, cleanup } = makeSession();
    const events: AgentEvent[] = [];
    try {
      await runTurn({
        prompt: 'hi',
        workspaceRoot: root,
        client: cacheClient(usage(20_000, 19_000), usage(21_000, 0)),
        session,
        sandbox,
        approver,
        contextWindow: 100_000,
        listener: (event) => events.push(event),
      });
      const misses = missEvents(session);
      assert.equal(misses.length, 1, '应当落一条 cache_miss 事件');
      const text = String(misses[0]?.text ?? '');
      assert.match(text, /20000 prompt tokens re-billed/);
      assert.match(text, /served none of the cached prefix/, '兜底归因描述机制（端点没读缓存），不编造确定原因');
      assert.equal(
        events.some((event) => event.type === 'status' && /cache miss/.test(event.text)),
        false,
        '这是后台留痕，不该作为界面通知打扰',
      );
    } finally {
      cleanup();
    }
  });

  it('命中良好时不留记录，也不打扰', async () => {
    const { session, root, cleanup } = makeSession();
    const events: AgentEvent[] = [];
    try {
      await runTurn({
        prompt: 'hi',
        workspaceRoot: root,
        client: cacheClient(usage(20_000, 19_000), usage(21_000, 20_000)),
        session,
        sandbox,
        approver,
        contextWindow: 100_000,
        listener: (event) => events.push(event),
      });
      assert.equal(missEvents(session).length, 0);
      assert.equal(events.some((event) => event.type === 'status' && /cache miss/.test(event.text)), false);
    } finally {
      cleanup();
    }
  });

  it('噪声下限以内的差值不算未命中', async () => {
    // 缓存断点按固定块对齐，几百 token 的差值是天然误差，报出来只会淹掉真问题。
    const { session, root, cleanup } = makeSession();
    const events: AgentEvent[] = [];
    try {
      await runTurn({
        prompt: 'hi',
        workspaceRoot: root,
        client: cacheClient(usage(20_000, 19_500), usage(21_000, 19_600)),
        session,
        sandbox,
        approver,
        contextWindow: 100_000,
        listener: (event) => events.push(event),
      });
      assert.equal(events.some((event) => event.type === 'status' && /cache miss/.test(event.text)), false);
    } finally {
      cleanup();
    }
  });
});

describe('系统提示词一轮内冻结', () => {
  /** 记录每次请求的 message 0（system），第一步调 enter_plan_mode、第二步收尾。 */
  function planToggleClient(seen: string[]): LlmClient {
    let calls = 0;
    return {
      async complete(messages: ChatMessage[]): Promise<StreamDelta> {
        calls += 1;
        seen.push(messages[0]?.role === 'system' ? String(messages[0].content) : '(no system)');
        if (calls === 1) {
          return {
            text: '',
            finishReason: 'tool-calls',
            toolCalls: [{ id: 'p1', name: 'enter_plan_mode', arguments: '{}' }],
          };
        }
        return { text: 'planning...', finishReason: 'stop' };
      },
    };
  }

  it('enter_plan_mode 中途生效时，本轮的 system 提示词保持逐字节不变', async () => {
    const { session, root, cleanup } = makeSession();
    const seen: string[] = [];
    try {
      await runTurn({
        prompt: 'design something',
        workspaceRoot: root,
        client: planToggleClient(seen),
        session,
        sandbox,
        approver,
        contextWindow: 100_000,
        planMode: { active: false },
      });
      assert.equal(seen.length, 2);
      assert.equal(seen[0], seen[1], 'message 0 在轮内改写会把缓存前缀整个作废');
      assert.match(seen[0] ?? '', /plan mode/i, '轮开始时的计划模式状态应已反映');
    } finally {
      cleanup();
    }
  });
});
