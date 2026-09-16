import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyAnthropicEvent, toAnthropicRequest } from './anthropic.js';
import { DEFAULT_REQUEST_CAPS } from './compat.js';
import { finishStream, newSseAcc } from './openai.js';
import type { ChatMessage } from './openai.js';

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
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: '{}' } }] },
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
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: '{}' } }] },
      { role: 'tool', content: '', tool_call_id: 'c1' },
    ];
    const body = toAnthropicRequest({ model: 'm', messages, tools: [] });
    const out = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    assert.deepEqual(out.at(-1)?.content.at(0)?.content, [{ type: 'text', text: '(no output)' }]);
  });

  it('有 tool_use 的 assistant 轮照常保留', () => {
    const messages: ChatMessage[] = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: '{}' } }] },
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
