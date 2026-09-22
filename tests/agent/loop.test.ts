import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runTurn } from '../../src/agent/loop.js';
import { JsonlSession } from '../../src/session/store.js';
import { defaultTools } from '../../src/tools/index.js';
import { PluginHost } from '../../src/plugins/host.js';
import { discoverPlugins } from '../../src/plugins/loader.js';
import type { AgentEvent } from '../../src/agent/events.js';
import type { ChatMessage, LlmClient, StreamDelta, TokenUsage } from '../../src/llm/openai.js';
import type { SandboxHandle } from '../../src/sandbox/types.js';
import type { Approver } from '../../src/permission/policy.js';

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
            tools: defaultTools,
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
        tools: defaultTools,
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
        tools: defaultTools,
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
            tools: defaultTools,
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

describe('参数降级进工作状态', () => {
  it('compat 重试既落会话事件，也发 status warn；传输抖动同样上屏', async () => {
    const { session, root, cleanup } = makeSession();
    const events: AgentEvent[] = [];
    const client: LlmClient = {
      async complete(_messages, _tools, _signal, _onDelta, onRetry) {
        onRetry?.({
          attempt: 2,
          message: 'LLM HTTP 400: unsupported prompt_cache_key; dropping extra request fields',
          kind: 'compat',
        });
        onRetry?.({ attempt: 2, message: 'socket hang up', kind: 'transport', maxRetries: 3 });
        return { text: 'ok', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      },
    };
    try {
      await runTurn({
        prompt: 'hi',
        workspaceRoot: root,
        client,
        session,
        tools: defaultTools,
        sandbox,
        approver,
        contextWindow: 100_000,
        listener: (event) => events.push(event),
      });
      const retries = session.readAll().flatMap((record) =>
        record.type === 'event' && record.kind === 'compat_retry' ? [record.data] : [],
      );
      assert.equal(retries.length, 1);
      assert.match(String(retries[0]?.message ?? ''), /prompt_cache_key/);
      // 传输抖动与 pi 的 auto_retry 同款落盘：次数、预算、错误原文、距本跳开始的耗时。
      const transport = session.readAll().flatMap((record) =>
        record.type === 'event' && record.kind === 'stream_retry' ? [record.data] : [],
      );
      assert.equal(transport.length, 1);
      assert.equal(transport[0]?.attempt, 2);
      assert.equal(transport[0]?.max, 3);
      assert.match(String(transport[0]?.message ?? ''), /socket hang up/);
      assert.equal(typeof transport[0]?.elapsedMs, 'number');
      assert.ok(events.some((event) => event.type === 'status' && event.level === 'warn' && /dropping extra request fields/.test(event.text)),
        '参数降级应进工作状态行',
      );
      assert.ok(
        events.some((event) => event.type === 'status' && /socket hang up/.test(event.text)),
        '传输抖动仍应上屏',
      );
    } finally {
      cleanup();
    }
  });
});

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
        tools: defaultTools,
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
        tools: defaultTools,
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
        tools: defaultTools,
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
      // enter_plan_mode 工具现在是 plan 插件的：跑这个测试必须把插件装进来，
      // 否则工具表里没有 enter_plan_mode，轮内「进入计划模式」根本不会发生。
      const pluginHost = new PluginHost({
        coreTools: defaultTools.list(),
        workspaceRoot: root,
        configPath: join(root, 'config.toml'),
      });
      const discovered = discoverPlugins({ workspaceRoot: root, userRoot: join(root, 'no-user') });
      await pluginHost.load(discovered.candidates, discovered.shadowed);
      try {
        await runTurn({
          prompt: 'design something',
          workspaceRoot: root,
          client: planToggleClient(seen),
          session,
          tools: pluginHost.tools(),
          services: pluginHost,
          sandbox,
          approver,
          contextWindow: 100_000,
          planMode: { active: false },
        });
      } finally {
        pluginHost.dispose();
      }
      assert.equal(seen.length, 2);
      assert.equal(seen[0], seen[1], 'message 0 在轮内改写会把缓存前缀整个作废');
      assert.match(seen[0] ?? '', /plan mode/i, '轮开始时的计划模式状态应已反映');
    } finally {
      cleanup();
    }
  });
});

describe('截断流继续', () => {
  it('没有 finish reason 时把已有正文落盘并再打一轮，而不是收工', async () => {
    const { session, root, cleanup } = makeSession();
    let calls = 0;
    const events: AgentEvent[] = [];
    const client: LlmClient = {
      async complete(): Promise<StreamDelta> {
        calls += 1;
        if (calls === 1) return { text: 'partial' };
        return { text: ' done', finishReason: 'stop' };
      },
    };
    try {
      await runTurn({
        prompt: 'hi',
        workspaceRoot: root,
        client,
        session,
        tools: defaultTools,
        sandbox,
        approver,
        contextWindow: 100_000,
        listener: (event) => events.push(event),
      });
      assert.equal(calls, 2);
      assert.ok(events.some((event) => event.type === 'status' && /without a finish reason/.test(event.text)));
      assert.ok(events.some((event) => event.type === 'done'));
      const assistant = session.readMessages().filter((row) => row.role === 'assistant');
      assert.equal(assistant[0]?.content, 'partial');
      assert.equal(assistant[1]?.content, ' done');
    } finally {
      cleanup();
    }
  });

  it('线协议 tool_calls（下划线）且没有工具载荷时不当成收工', async () => {
    const { session, root, cleanup } = makeSession();
    let calls = 0;
    const client: LlmClient = {
      async complete(): Promise<StreamDelta> {
        calls += 1;
        if (calls === 1) return { text: '', finishReason: 'tool_calls' };
        return { text: 'done', finishReason: 'stop' };
      },
    };
    try {
      await runTurn({
        prompt: 'hi',
        workspaceRoot: root,
        client,
        session,
        tools: defaultTools,
        sandbox,
        approver,
        contextWindow: 100_000,
      });
      assert.equal(calls, 2);
    } finally {
      cleanup();
    }
  });
});

describe('取消 rewind：首次响应前中止不落盘用户消息', () => {
  it('abort 发生在 complete 返回之前时，会话里没有 user / turn_start', async () => {
    const { session, root, cleanup } = makeSession();
    const controller = new AbortController();
    const client: LlmClient = {
      async complete(_messages, _tools, signal) {
        controller.abort();
        if (signal?.aborted) throw new Error('aborted');
        throw new Error('aborted');
      },
    };
    try {
      await assert.rejects(
        () =>
          runTurn({
            prompt: 'restore me',
            workspaceRoot: root,
            client,
            session,
            tools: defaultTools,
            sandbox,
            approver,
            contextWindow: 100_000,
            signal: controller.signal,
          }),
        /aborted/,
      );
      const records = session.readAll();
      assert.equal(records.some((row) => row.type === 'message' && row.role === 'user'), false);
      assert.equal(records.some((row) => row.type === 'event' && row.kind === 'turn_start'), false);
    } finally {
      cleanup();
    }
  });
});

describe('子代理审批策略', () => {
  /** 按脚本依次返回；脚本用尽后一直返回最后一项。 */
  function scriptedClient(script: StreamDelta[]): LlmClient {
    let index = 0;
    return {
      async complete(): Promise<StreamDelta> {
        const step = script[Math.min(index, script.length - 1)];
        index++;
        return step!;
      },
    };
  }

  const SPAWN: StreamDelta = {
    text: '',
    finishReason: 'tool-calls',
    toolCalls: [{ id: 's1', name: 'subagent', arguments: '{"prompt":"child work","description":"child work"}' }],
  };
  const SHELL: StreamDelta = {
    text: '',
    finishReason: 'tool-calls',
    toolCalls: [{ id: 'c1', name: 'bash', arguments: '{"command":"npm test"}' }],
  };
  const DONE: StreamDelta = { text: 'done', finishReason: 'stop' };

  /** 父先 spawn 子代理，子跑一条受审的 shell，然后各自收尾。 */
  async function spawnThenShell(subagentApprover?: Approver): Promise<string[]> {
    const { session, root, cleanup } = makeSession();
    const seen: string[] = [];
    try {
      await runTurn({
        prompt: 'hi',
        workspaceRoot: root,
        client: scriptedClient([SPAWN, SHELL, DONE, DONE]),
        session,
        tools: defaultTools,
        sandbox,
        approver: { decide: async () => { seen.push('parent'); return true; } },
        ...(subagentApprover === undefined ? {} : { subagentApprover }),
        contextWindow: 100_000,
      });
    } finally {
      cleanup();
    }
    return seen;
  }

  it('给了 subagentApprover 时，子代理的受审工具由它判定', async () => {
    const childSeen: string[] = [];
    const parentSeen = await spawnThenShell({ decide: async () => { childSeen.push('child'); return true; } });
    assert.deepEqual(childSeen, ['child'], '子代理的 shell 调用必须由 subagentApprover 判定');
    assert.deepEqual(parentSeen, [], '父会话的 approver 不该被子代理的调用碰到');
  });

  it('省略 subagentApprover 时沿用父会话的 approver（inherit）', async () => {
    assert.deepEqual(await spawnThenShell(), ['parent']);
  });
});
