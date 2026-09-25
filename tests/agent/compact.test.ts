import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ChatMessage } from '../../src/plugins/sph-llm/openai.js';
import type { SessionMessage } from '../../src/session/types.js';
import { jsonlSessionFactory } from '../../src/plugins/sph-session/store.js';
import {
  estimateTokens,
  emptyWire,
  flushWireAttachments,
  openCompactedSession,
  pairingBalancedCut,
  pushSessionMessage,
  toChatMessages,
  projectContext,
} from '../../src/plugins/sph-loop/compact.js';

function session(partial: Omit<SessionMessage, 'type' | 'ts'>): SessionMessage {
  return { type: 'message', ts: '2026-01-01T00:00:00.000Z', ...partial };
}

describe('pairingBalancedCut', () => {
  it('slides a cut that lands on a tool result back to its assistant', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'u1' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }],
      },
      { role: 'tool', content: 'a', tool_call_id: 'c1', name: 'read' },
      { role: 'tool', content: 'b', tool_call_id: 'c2', name: 'grep' },
      { role: 'user', content: 'u2' },
    ];
    assert.equal(pairingBalancedCut(messages, 2), 1);
    assert.equal(pairingBalancedCut(messages, 3), 1);
    assert.equal(pairingBalancedCut(messages, 4), 4);
    assert.equal(pairingBalancedCut(messages, 1), 1);
  });
});

describe('wire incremental projection', () => {
  it('matches a full toChatMessages rebuild, including tool images', () => {
    const rows = [
      session({ role: 'user', content: 'hi' }),
      session({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'a.png' } }],
      }),
      session({
        role: 'tool',
        content: 'img',
        toolCallId: 'c1',
        toolName: 'read',
        images: ['data:image/png;base64,xx'],
      }),
      session({ role: 'assistant', content: 'done' }),
    ];
    const full = toChatMessages(rows);
    const state = emptyWire();
    for (const row of rows) pushSessionMessage(state, row);
    flushWireAttachments(state);
    assert.deepEqual(state.messages, full);
  });

  it('assistant 的 reasoning 进 wire，下一轮才能回传', () => {
    const rows = [
      session({ role: 'user', content: 'hi' }),
      session({
        role: 'assistant',
        content: '看',
        toolCalls: [{ id: 'c1', name: 'ls', arguments: { path: '.' } }],
        reasoning: [{ id: 'rs_1', encryptedContent: 'enc' }],
      }),
    ];
    const [assistant] = toChatMessages(rows).filter((row) => row.role === 'assistant');
    assert.equal(assistant?.reasoning?.[0]?.encryptedContent, 'enc');
  });
});

describe('estimateTokens', () => {
  it('counts utf8 bytes, not JS string length', () => {
    const message: ChatMessage = { role: 'user', content: '你好' };
    const json = JSON.stringify(message);
    const bytes = Buffer.byteLength(json, 'utf8');
    assert.ok(bytes > json.length);
    assert.equal(estimateTokens([message]), Math.ceil(bytes / 4));
  });
});

describe('stub 头尾预览', () => {
  it('长 tool result 保留头尾，不整段换成一行', async () => {
    const explodingClient = {
      complete: async (): Promise<never> => {
        throw new Error('summary path must not run');
      },
    } as unknown as Parameters<typeof projectContext>[0]['client'];
    const messages: SessionMessage[] = [];
    for (let i = 1; i <= 6; i++) {
      messages.push(session({ role: 'user', content: `turn ${i}` }));
      messages.push(session({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: `c${i}`, name: 'read', arguments: { path: `f${i}` } }],
      }));
      messages.push(session({
        role: 'tool',
        content: 'x'.repeat(40_000),
        toolCallId: `c${i}`,
        toolName: 'read',
      }));
    }
    const result = await projectContext({
      messages,
      contextWindow: 68_750,
      client: explodingClient,
    });
    const stubbed = result.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'c1');
    assert.ok(stubbed);
    assert.ok(stubbed.content.includes('[compacted tool result]'));
    assert.ok(stubbed.content.includes('...'));
    assert.ok(stubbed.content.length > 800);
  });
});

describe('压缩请求复用对话前缀', () => {
  it('摘要调用以原 system 打头、压缩指令垫在最后一条 user', async () => {
    const captured: Array<{ messages: ChatMessage[]; tools: unknown[] }> = [];
    let compactingBeforeRequest = false;
    const client = {
      async complete(messages: ChatMessage[], tools: unknown[]) {
        captured.push({ messages, tools });
        return { text: '## Goal and Acceptance Criteria\n- done', finishReason: 'stop' };
      },
    } as unknown as Parameters<typeof projectContext>[0]['client'];
    const messages: SessionMessage[] = [];
    for (let i = 1; i <= 12; i++) {
      messages.push(session({ role: 'user', content: `turn ${i} ${'q'.repeat(2000)}` }));
      messages.push(session({ role: 'assistant', content: `a${i} ${'z'.repeat(2000)}` }));
    }
    await projectContext({
      messages,
      contextWindow: 800,
      client,
      system: 'You are sph',
      tools: [{ type: 'function', function: { name: 'read' } }],
      onCompacting: () => {
        compactingBeforeRequest = captured.length === 0;
      },
    });
    assert.equal(compactingBeforeRequest, true, 'onCompacting 必须在摘要请求发出之前');
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.messages[0]?.role, 'system');
    assert.equal(captured[0]?.messages[0]?.content, 'You are sph');
    const last = captured[0]?.messages.at(-1);
    assert.equal(last?.role, 'user');
    assert.match(String(last?.content), /compaction engine/);
    const tools = captured[0]?.tools as { function?: { name?: string } }[] | undefined;
    assert.equal(tools?.[0]?.function?.name, 'read');
  });
});

describe('手动压缩（/compact）', () => {
  const summaryClient = (captured: ChatMessage[][]) => ({
    async complete(messages: ChatMessage[]) {
      captured.push(messages);
      return { text: '## Goal and Acceptance Criteria\n- done', finishReason: 'stop' };
    },
  } as unknown as Parameters<typeof projectContext>[0]['client']);

  /**
   * 12 轮，且每轮都撑到 2000 字符：消息太小时 stub 级就能把水位线压下去，摘要根本不跑，
   * 断言会退化成「测了个空」。窗口给 800 时这条会话必然越过水位线。
   */
  function twelveTurns(): SessionMessage[] {
    const messages: SessionMessage[] = [];
    for (let i = 1; i <= 12; i++) {
      messages.push(session({ role: 'user', content: `turn ${i} ${'q'.repeat(2000)}` }));
      messages.push(session({ role: 'assistant', content: `a${i} ${'z'.repeat(2000)}` }));
    }
    return messages;
  }

  it('instructions 接在固定指令之后，段落结构不被顶掉', async () => {
    const captured: ChatMessage[][] = [];
    await projectContext({
      messages: twelveTurns(),
      contextWindow: 800,
      client: summaryClient(captured),
      instructions: 'focus on the auth changes',
    });
    const last = captured[0]?.at(-1);
    assert.equal(last?.role, 'user');
    assert.match(String(last?.content), /compaction engine/, '固定指令仍在');
    assert.match(String(last?.content), /Output EXACTLY the sections below/, '段落结构没被指令顶掉');
    assert.match(String(last?.content), /focus on the auth changes/, '聚焦说明被带上');
  });

  it('不传 instructions 时指令与自动路径逐字相同', async () => {
    const captured: ChatMessage[][] = [];
    await projectContext({ messages: twelveTurns(), contextWindow: 800, client: summaryClient(captured) });
    assert.equal(String(captured[0]?.at(-1)?.content).includes('Additional focus'), false);
  });

  it('force 让远未到水位线的会话也能压缩（/compact 走的就是这条路）', async () => {
    const captured: ChatMessage[][] = [];
    const client = summaryClient(captured);
    const messages = twelveTurns();
    // 窗口给得极大：不 force 必然在水位线判断处早退，force 才会走到摘要。
    const passive = await projectContext({ messages, contextWindow: 10_000_000, client });
    assert.equal(passive.compaction, undefined);
    assert.equal(captured.length, 0, '未到水位线时不该产生摘要调用');

    const forced = await projectContext({ messages, contextWindow: 10_000_000, client, force: true });
    assert.equal(forced.compaction?.covered, messages.length - 8, '覆盖到保留窗口之前');
  });
});

describe('stub 边界冻结', () => {
  const TOOL_BYTES = 40_000;
  const CONTEXT_WINDOW = 68_750; // 水位线 = 55_000 tokens：6 轮全量超线、4 轮完好低于线

  /** 一轮 = user + assistant(tool_calls) + 大号 tool result。 */
  function turn(index: number): SessionMessage[] {
    return [
      session({ role: 'user', content: `turn ${index}` }),
      session({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: `c${index}`, name: 'read', arguments: { path: `f${index}` } }],
      }),
      session({
        role: 'tool',
        content: 'x'.repeat(TOOL_BYTES),
        toolCallId: `c${index}`,
        toolName: 'read',
      }),
    ];
  }

  const explodingClient = {
    complete: async (): Promise<never> => {
      throw new Error('summary path must not run');
    },
  } as unknown as Parameters<typeof projectContext>[0]['client'];

  it('冻结后跨轮追加，投影前缀逐字节不变；不冻结则边界前移（对照）', async () => {
    const mirror1 = [1, 2, 3, 4, 5, 6].flatMap(turn);
    const first = await projectContext({
      messages: mirror1,
      contextWindow: CONTEXT_WINDOW,
      client: explodingClient,
    });
    assert.equal(first.compaction, undefined, 'stub级足够时不应触发摘要');
    assert.notEqual(first.stubbedFromSession, undefined, '首次 stub 应回报边界');
    const turn3InFirst = first.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'c3');
    assert.equal(turn3InFirst?.content.includes('[compacted tool result]'), false, '边界之后的轮保持原文');

    // 下一轮：追加第 7 轮，带上冻结边界。
    const mirror2 = [...mirror1, ...turn(7)];
    const second = await projectContext({
      messages: mirror2,
      contextWindow: CONTEXT_WINDOW,
      client: explodingClient,
      stubFromSession: first.stubbedFromSession,
    });
    assert.equal(
      JSON.stringify(second.messages.slice(0, first.messages.length)),
      JSON.stringify(first.messages),
      '冻结生效：前一步的投影是本轮前缀的逐字节复制，缓存全额命中',
    );

    // 对照组：同一会话不冻结，窗口前移，第 3 轮的 tool result 被改写成 stub。
    const sliding = await projectContext({
      messages: mirror2,
      contextWindow: CONTEXT_WINDOW,
      client: explodingClient,
    });
    const turn3Sliding = sliding.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'c3');
    assert.equal(
      turn3Sliding?.content.includes('[compacted tool result]'),
      true,
      '不冻结时边界随轮次前移——这正是要消除的历史中段改写',
    );
  });
});

describe('assistant thinking 回放载荷透传', () => {
  it('工具调用行携带 thinking + thinkingSignature 进 wire', () => {
    const state = emptyWire();
    pushSessionMessage(state, session({
      role: 'assistant',
      content: '',
      thinking: 'let me look',
      thinkingSignature: 'sig-1',
      toolCalls: [{ id: 'tu_1', name: 'read', arguments: { path: 'a' } }],
    }));
    const message = state.messages[0]!;
    assert.equal(message.thinking, 'let me look');
    assert.equal(message.thinkingSignature, 'sig-1');
    assert.equal(message.tool_calls?.[0]?.id, 'tu_1');
  });

  it('纯文本行同样携带 thinking 载荷', () => {
    const state = emptyWire();
    pushSessionMessage(state, session({
      role: 'assistant',
      content: 'answer',
      thinking: 'thought',
      thinkingSignature: 'sig-2',
    }));
    const message = state.messages[0]!;
    assert.equal(message.thinking, 'thought');
    assert.equal(message.thinkingSignature, 'sig-2');
  });
});

describe('user 附件投影', () => {
  it('@ 附件拼进发给模型的文本，正文保持用户原文', () => {
    const state = emptyWire();
    pushSessionMessage(state, session({
      role: 'user',
      content: '看下这个',
      attachments: [{ path: 'a.ts', content: 'X' }, { path: 'b.ts', error: 'file not found' }],
    }));
    assert.equal(
      state.messages[0]!.content,
      '看下这个\n\n<attached-files>\n<file path="a.ts">\nX\n</file>\n<file path="b.ts" error="file not found" />\n</attached-files>',
    );
  });

  it('无附件的 user 行内容原样', () => {
    const state = emptyWire();
    pushSessionMessage(state, session({ role: 'user', content: 'plain' }));
    assert.equal(state.messages[0]!.content, 'plain');
  });

  it('增量投影与全量重建一致（附件行）', () => {
    const rows = [
      session({ role: 'user', content: 'hi', attachments: [{ path: 'a.ts', content: 'X' }] }),
      session({ role: 'assistant', content: 'ok' }),
    ];
    const full = toChatMessages(rows);
    const state = emptyWire();
    for (const row of rows) pushSessionMessage(state, row);
    assert.deepEqual(state.messages, full);
  });
});

describe('压缩新开会话', () => {
  it('原会话消息不变，新会话以摘要开头并带上未覆盖的尾部', () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-fork-'));
    try {
      const from = jsonlSessionFactory.create(root, root, true);
      for (let i = 1; i <= 4; i++) from.appendMessage({ role: 'user', content: `turn ${i}` });
      from.appendEvent('goal', { text: 'ship the fix' });
      const before = from.readMessages().map((row) => row.content);
      const opened = openCompactedSession({
        factory: jsonlSessionFactory,
        from,
        workspaceRoot: root,
        makeCurrent: true,
        summary: 'checkpoint body',
        covered: 2,
        depth: 0,
      });
      assert.deepEqual(from.readMessages().map((row) => row.content), before, '原会话的消息一个字不能改');
      assert.equal(
        from.readAll().some((record) => record.type === 'event' && record.kind === 'compaction'),
        false,
      );
      assert.equal(
        from.readAll().some((record) => record.type === 'event' && record.kind === 'session_fork' && record.data.to === opened.session.id),
        true,
      );
      const messages = opened.session.readMessages();
      assert.match(messages[0]?.content ?? '', /compacted earlier context/);
      assert.match(messages[0]?.content ?? '', /checkpoint body/);
      assert.deepEqual(messages.slice(1).map((row) => row.content), ['turn 3', 'turn 4']);
      const goal = opened.session.readAll().find((record) => record.type === 'event' && record.kind === 'goal');
      assert.equal(goal && goal.type === 'event' ? goal.data.text : undefined, 'ship the fix');
      assert.notEqual(opened.session.id, from.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('wire 文档投影', () => {
  const document = { filename: 'spec.pdf', url: 'data:application/pdf;base64,JVBERi0=' };

  it('user 消息的 documents 变成 document parts，与 images 同列表', () => {
    const rows = [
      session({ role: 'user', content: '看这份合同', images: ['data:image/png;base64,xx'], documents: [document] }),
    ];
    const [user] = toChatMessages(rows);
    assert.deepEqual(user?.parts, [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,xx' } },
      { type: 'document', document },
    ]);
  });

  it('tool 消息的 documents 走侧信道，flush 成一条 [tool result document]', () => {
    const rows = [
      session({ role: 'user', content: '读 spec.pdf' }),
      session({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'spec.pdf' } }],
      }),
      session({ role: 'tool', content: 'pdf attached', toolCallId: 'c1', toolName: 'read', documents: [document] }),
    ];
    const messages = toChatMessages(rows);
    assert.deepEqual(messages.at(-1), {
      role: 'user',
      content: '[tool result document]',
      parts: [{ type: 'document', document }],
    });
    // 全量重建与增量投影一致：文档侧信道不破坏投影不变式。
    const state = emptyWire();
    for (const row of rows) pushSessionMessage(state, row);
    flushWireAttachments(state);
    assert.deepEqual(state.messages, messages);
  });
});
