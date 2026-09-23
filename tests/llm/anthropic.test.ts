import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyAnthropicEvent, toAnthropicRequest } from '../../src/plugins/sph-llm/anthropic.js';
import { DEFAULT_REQUEST_CAPS } from '../../src/plugins/sph-llm/compat.js';
import { finishStream, newSseAcc } from '../../src/plugins/sph-llm/openai.js';
import type { ChatMessage } from '../../src/plugins/sph-llm/openai.js';

const user = (content: string): ChatMessage => ({ role: 'user', content });

function tool(name: string): Record<string, unknown> {
  return { type: 'function', function: { name, description: '', parameters: {} } };
}

/** 数一遍请求体里出现了几个 cache_control 断点（Anthropic 上限 4 个）。 */
function countBreakpoints(body: Record<string, unknown>): number {
  let total = 0;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (record.cache_control !== undefined) total++;
      for (const nested of Object.values(record)) visit(nested);
    }
  };
  visit(body);
  return total;
}

const BREAKPOINT = { type: 'ephemeral' };

describe('toAnthropicRequest prompt cache', () => {
  it('三段前缀各打一个断点：system / 最后一个工具 / 最后一条消息', () => {
    const body = toAnthropicRequest({
      model: 'claude-sonnet-4',
      messages: [{ role: 'system', content: 'sys' }, user('hi')],
      tools: [tool('a'), tool('b')],
    });

    const system = body.system as Array<Record<string, unknown>>;
    assert.equal(Array.isArray(system), true);
    assert.equal(system[0]?.text, 'sys');
    assert.deepEqual(system[0]?.cache_control, BREAKPOINT);

    const tools = body.tools as Array<Record<string, unknown>>;
    assert.equal(tools[0]?.cache_control, undefined, '断点只打最后一个工具，覆盖整批前缀');
    assert.deepEqual(tools[1]?.cache_control, BREAKPOINT);

    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    assert.deepEqual(messages.at(-1)?.content.at(-1)?.cache_control, BREAKPOINT);
    assert.equal(countBreakpoints(body), 3, '不能超过 Anthropic 的 4 个上限');
  });

  it('末尾是 tool_result 时断点锚在最后一条 assistant 的 tool_use 上', () => {
    // 锚点 = 上一次请求的结束位置。当前步的 tool_result 留在断点之后：本步原价读取，
    // 下一步随新 assistant 一起进入缓存前缀——比挂在绝对末尾晚一步写入，但锚点不会
    // 随消息增长滑出 lookback 窗口，还省下一个断点槽位。
    const messages: ChatMessage[] = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
      { role: 'tool', content: 'exit 0', tool_call_id: 'c1' },
    ];
    const body = toAnthropicRequest({ model: 'm', messages, tools: [] });
    const out = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    assert.deepEqual(out[0]?.content.at(-1)?.cache_control, BREAKPOINT, '断点落在 assistant 的 tool_use 上');
    assert.equal(out.at(-1)?.content.at(-1)?.cache_control, undefined, '当前步的 tool_result 不挂断点');
    assert.equal(countBreakpoints(body), 1);
  });

  it('多步对话中途：断点跟着最后一条 assistant 走，而不是绝对末尾', () => {
    const messages: ChatMessage[] = [
      user('hi'),
      { role: 'assistant', content: 'let me look' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'glob', arguments: '{}' } }] },
      { role: 'tool', content: 'a.ts', tool_call_id: 'c2' },
    ];
    const body = toAnthropicRequest({ model: 'm', messages, tools: [] });
    const out = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    assert.deepEqual(out[1]?.content.at(-1)?.cache_control, undefined, '更早的 assistant 不挂点');
    assert.deepEqual(out[2]?.content.at(-1)?.cache_control, BREAKPOINT, '锚在最后一条 assistant');
    assert.equal(out[3]?.content.at(-1)?.cache_control, undefined);
  });

  it('新会话第一步没有任何 assistant 消息时，退回最后一条 user 消息', () => {
    const body = toAnthropicRequest({ model: 'm', messages: [user('hi')], tools: [] });
    const out = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    assert.deepEqual(out.at(-1)?.content.at(-1)?.cache_control, BREAKPOINT);
  });

  it('prompt_cache = false 时不打任何断点，system 退回裸字符串', () => {
    const body = toAnthropicRequest(
      {
        model: 'claude-sonnet-4',
        messages: [{ role: 'system', content: 'sys' }, user('hi')],
        tools: [tool('a')],
      },
      { ...DEFAULT_REQUEST_CAPS, promptCache: false },
    );
    assert.equal(typeof body.system, 'string');
    assert.equal(countBreakpoints(body), 0);
  });

  it('没有系统提示词时不发 system 字段', () => {
    const body = toAnthropicRequest({ model: 'm', messages: [user('hi')], tools: [] });
    assert.equal('system' in body, false);
  });
});

describe('toAnthropicRequest 空块防护', () => {
  it('既无正文也无工具调用的空 assistant 轮不进请求', () => {
    // Anthropic 拒收 content: []，而这类空轮对历史没有任何信息量。
    const messages: ChatMessage[] = [user('hi'), { role: 'assistant', content: '' }, user('again')];
    const body = toAnthropicRequest({ model: 'm', messages, tools: [] });
    const out = body.messages as Array<{ role: string; content: unknown[] }>;
    assert.deepEqual(out.map((message) => message.role), ['user', 'user']);
    assert.equal(out.every((message) => message.content.length > 0), true);
  });

  it('工具返回空内容时兜一个占位块，不留空 content 数组', () => {
    const messages: ChatMessage[] = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
      { role: 'tool', content: '', tool_call_id: 'c1' },
    ];
    const body = toAnthropicRequest({ model: 'm', messages, tools: [] });
    const out = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    assert.deepEqual(out.at(-1)?.content.at(0)?.content, [{ type: 'text', text: '(no output)' }]);
  });

  it('有 tool_use 的 assistant 轮照常保留', () => {
    const messages: ChatMessage[] = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
    ];
    const body = toAnthropicRequest({ model: 'm', messages, tools: [] });
    const out = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    assert.equal(out[0]?.content.at(0)?.type, 'tool_use');
  });
});

describe('toAnthropicRequest 输出上限', () => {
  it('thinking 预算叠加到显式 max_tokens 之上', () => {
    const body = toAnthropicRequest({
      model: 'm',
      messages: [user('hi')],
      tools: [],
      maxTokens: 8192,
      reasoningEffort: 'medium',
    });
    assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 4096 });
    assert.equal(body.max_tokens, 8192 + 4096);
  });

  it('未配置上限时用 8192 基数', () => {
    const body = toAnthropicRequest({ model: 'm', messages: [user('hi')], tools: [] });
    assert.equal(body.max_tokens, 8192);
    assert.equal(body.thinking, undefined);
  });
});

describe('applyAnthropicEvent 非流式报文', () => {
  it('type=message 完整 JSON 收下正文与 stop', () => {
    const acc = newSseAcc();
    applyAnthropicEvent(
      JSON.stringify({
        type: 'message',
        content: [{ type: 'text', text: 'hello' }],
        stop_reason: 'end_turn',
      }),
      acc,
    );
    const reply = finishStream(acc);
    assert.equal(reply.text, 'hello');
    assert.equal(reply.finishReason, 'stop');
  });

  it('[DONE] 不当成 JSON 解析失败', () => {
    const acc = newSseAcc();
    assert.deepEqual(applyAnthropicEvent('[DONE]', acc), {});
  });
});

describe('applyAnthropicEvent 流式 usage', () => {
  it('message_delta 的 usage 在事件顶层，不是嵌在 delta 里', () => {
    // 规范形态，官方 API / Bedrock / Vertex 都这么发。曾经读 data.delta.usage，
    // 于是所有按规范实现的端点 token 统计恒为 0（zen 的 message_start 又只给 0，
    // 两头都拿不到真值）。prompt 是 input + cache_read 的归一化口径。
    const acc = newSseAcc();
    applyAnthropicEvent(
      JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 0, output_tokens: 0 } } }),
      acc,
    );
    applyAnthropicEvent(
      JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { input_tokens: 10, output_tokens: 67, cache_read_input_tokens: 12 },
      }),
      acc,
    );
    assert.deepEqual(finishStream(acc).usage, {
      promptTokens: 22,
      completionTokens: 67,
      totalTokens: 89,
      cachedTokens: 12,
    });
  });

  it('usage 被塞进 delta 的非规范网关仍然读得到', () => {
    const acc = newSseAcc();
    applyAnthropicEvent(
      JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', usage: { output_tokens: 42 } } }),
      acc,
    );
    assert.equal(finishStream(acc).usage?.completionTokens, 42);
  });

  it('message_delta 只带 output_tokens 时不把 message_start 的输入抹成 0', () => {
    const acc = newSseAcc();
    applyAnthropicEvent(
      JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 40 } } }),
      acc,
    );
    applyAnthropicEvent(JSON.stringify({ type: 'message_delta', delta: {}, usage: { output_tokens: 7 } }), acc);
    assert.deepEqual(finishStream(acc).usage, {
      promptTokens: 140,
      completionTokens: 7,
      totalTokens: 147,
      cachedTokens: 40,
    });
  });
});

describe('thinking 回放（官方 API 强制 tool_use 前置 thinking 块）', () => {
  it('thinking 启用时含 tool_calls 的 assistant 以 thinking 块开头（签名完整）', () => {
    const body = toAnthropicRequest({
      model: 'claude-sonnet-4',
      reasoningEffort: 'high',
      messages: [
        user('hi'),
        {
          role: 'assistant',
          content: '',
          thinking: 'let me check',
          thinkingSignature: 'sig-abc',
          tool_calls: [{ id: 'tu_1', type: 'function', function: { name: 'a', arguments: '{}' } }],
        },
        { role: 'tool', content: 'done', tool_call_id: 'tu_1' },
      ],
      tools: [tool('a')],
    });
    const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    const assistant = messages.find((m) => m.role === 'assistant')!;
    assert.equal(assistant.content[0]?.type, 'thinking');
    assert.equal(assistant.content[0]?.thinking, 'let me check');
    assert.equal(assistant.content[0]?.signature, 'sig-abc');
  });

  it('签名缺失时降级为纯文本块，请求至少能通过', () => {
    const body = toAnthropicRequest({
      model: 'claude-sonnet-4',
      reasoningEffort: 'high',
      messages: [
        user('hi'),
        {
          role: 'assistant',
          content: '',
          thinking: 'let me check',
          tool_calls: [{ id: 'tu_1', type: 'function', function: { name: 'a', arguments: '{}' } }],
        },
      ],
      tools: [tool('a')],
    });
    const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    const assistant = messages.find((m) => m.role === 'assistant')!;
    assert.equal(assistant.content[0]?.type, 'text');
    assert.equal(assistant.content[0]?.text, 'let me check');
  });

  it('thinking 关闭时历史里的 thinking 载荷不回放', () => {
    const body = toAnthropicRequest({
      model: 'claude-sonnet-4',
      messages: [
        user('hi'),
        {
          role: 'assistant',
          content: '',
          thinking: 'let me check',
          thinkingSignature: 'sig-abc',
          tool_calls: [{ id: 'tu_1', type: 'function', function: { name: 'a', arguments: '{}' } }],
        },
      ],
      tools: [tool('a')],
    });
    const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    const assistant = messages.find((m) => m.role === 'assistant')!;
    assert.equal(assistant.content.some((b) => b.type === 'thinking'), false);
  });
});

describe('signature_delta 捕获', () => {
  it('流式 signature_delta 累积到 finishStream', () => {
    const acc = newSseAcc();
    applyAnthropicEvent(JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }), acc);
    applyAnthropicEvent(JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }), acc);
    applyAnthropicEvent(JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-' } }), acc);
    applyAnthropicEvent(JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'xyz' } }), acc);
    const reply = finishStream(acc);
    assert.equal(reply.thinking, 'hmm');
    assert.equal(reply.thinkingSignature, 'sig-xyz');
  });

  it('stop_reason 新增变体归一：refusal / sensitive / model_context_window_exceeded', () => {
    for (const [wire, want] of [
      ['refusal', 'refusal'],
      ['sensitive', 'sensitive'],
      ['model_context_window_exceeded', 'context_full'],
      ['pause_turn', 'stop'],
      ['stop_sequence', 'stop'],
    ] as const) {
      const acc = newSseAcc();
      applyAnthropicEvent(JSON.stringify({ type: 'message_delta', delta: { stop_reason: wire } }), acc);
      assert.equal(finishStream(acc).finishReason, want, wire);
    }
  });
});
