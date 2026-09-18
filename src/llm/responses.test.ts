import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyResponsesEvent, buildResponsesRequest, toResponsesInput } from './responses.js';
import { DEFAULT_REQUEST_CAPS } from './compat.js';
import { finishStream, newSseAcc } from './openai.js';
import type { ChatMessage } from './openai.js';

const user = (content: string): ChatMessage => ({ role: 'user', content });

describe('buildResponsesRequest', () => {
  it('只发 effort，不发 summary', () => {
    // 申请摘要会让模型在工具调用轮次里不再写可见前言，而该端点又不推 reasoning 事件，
    // 用户两头都拿不到——实测 5/5 复现，故不发。详见 responses.ts 的注释。
    const body = buildResponsesRequest({ model: 'm', messages: [user('hi')], tools: [], reasoningEffort: 'xhigh' });
    assert.deepEqual(body.reasoning, { effort: 'xhigh' });
  });

  it('off / 未设置时不带 reasoning 对象', () => {
    for (const effort of ['off', undefined] as const) {
      const body = buildResponsesRequest({ model: 'm', messages: [user('hi')], tools: [], reasoningEffort: effort });
      assert.equal(body.reasoning, undefined, `effort=${effort}`);
    }
  });

  it('带 tools 时发 tool_choice auto', () => {
    const body = buildResponsesRequest({
      model: 'm',
      messages: [user('hi')],
      tools: [{ type: 'function', function: { name: 'read_file', description: '', parameters: {} } }],
    });
    assert.equal(body.tool_choice, 'auto');
  });

  it('默认发 store: false：无状态调用用不上服务端留存，也与「跑在本机」的定位相悖', () => {
    const body = buildResponsesRequest({
      model: 'm',
      messages: [user('hi')],
      tools: [],
      reasoningEffort: 'xhigh',
    });
    assert.equal(body.store, false);
    assert.equal(body.include, undefined);
  });

  it('端点不认 store 时整条摘掉该字段，而不是硬失败', () => {
    const body = buildResponsesRequest(
      { model: 'm', messages: [user('hi')], tools: [] },
      { ...DEFAULT_REQUEST_CAPS, sendStore: false },
    );
    assert.equal(body.store, undefined);
  });
});

describe('applyResponsesEvent 工具调用', () => {
  it('[DONE] 不当成 JSON 解析失败', () => {
    const acc = newSseAcc();
    assert.deepEqual(applyResponsesEvent('[DONE]', acc), {});
  });

  it('并行 function_call 的 arguments.delta 按 item_id 寻址', () => {
    const acc = newSseAcc();
    applyResponsesEvent(
      JSON.stringify({
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'read_file', arguments: '' },
      }),
      acc,
    );
    applyResponsesEvent(
      JSON.stringify({
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'glob', arguments: '' },
      }),
      acc,
    );
    applyResponsesEvent(
      JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'fc_a', delta: '{"path":"a"}' }),
      acc,
    );
    applyResponsesEvent(
      JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'fc_b', delta: '{"pattern":"*"}' }),
      acc,
    );
    const calls = finishStream(acc).toolCalls ?? [];
    assert.equal(calls[0]?.arguments, '{"path":"a"}');
    assert.equal(calls[1]?.arguments, '{"pattern":"*"}');
  });

  it('没有 completed 时 finish 保持空，交给 loop 再打一轮', () => {
    const acc = newSseAcc();
    applyResponsesEvent(JSON.stringify({ type: 'response.output_text.delta', delta: '正在看模块。' }), acc);
    assert.equal(finishStream(acc).finishReason, undefined);
  });

  it('从 output_item.done 收下 encrypted_content', () => {
    const acc = newSseAcc();
    applyResponsesEvent(
      JSON.stringify({
        type: 'response.output_item.done',
        item: {
          type: 'reasoning',
          id: 'rs_1',
          encrypted_content: 'blob',
          summary: [{ type: 'summary_text', text: '先看目录' }],
        },
      }),
      acc,
    );
    const reasoning = finishStream(acc).reasoning ?? [];
    assert.equal(reasoning[0]?.id, 'rs_1');
    assert.equal(reasoning[0]?.encryptedContent, 'blob');
    assert.equal(reasoning[0]?.summary, '先看目录');
  });
});

describe('applyResponsesEvent 思考链', () => {
  it('summary delta 读的是 delta 字段', () => {
    const acc = newSseAcc();
    const out = applyResponsesEvent(
      JSON.stringify({
        type: 'response.reasoning_summary_text.delta',
        summary_index: 0,
        delta: '先看目录结构',
      }),
      acc,
    );
    assert.equal(out.thinkingDelta, '先看目录结构');
    assert.equal(acc.thinking, '先看目录结构');
  });

  it('reasoning_text delta 同样读 delta', () => {
    const acc = newSseAcc();
    const out = applyResponsesEvent(
      JSON.stringify({ type: 'response.reasoning_text.delta', delta: 'raw thought' }),
      acc,
    );
    assert.equal(out.thinkingDelta, 'raw thought');
  });

  it('多段摘要之间补换行，避免挤成一行', () => {
    const acc = newSseAcc();
    applyResponsesEvent(JSON.stringify({ type: 'response.reasoning_summary_part.added', summary_index: 0 }), acc);
    applyResponsesEvent(
      JSON.stringify({ type: 'response.reasoning_summary_text.delta', summary_index: 0, delta: '第一段。' }),
      acc,
    );
    applyResponsesEvent(JSON.stringify({ type: 'response.reasoning_summary_part.added', summary_index: 1 }), acc);
    applyResponsesEvent(
      JSON.stringify({ type: 'response.reasoning_summary_text.delta', summary_index: 1, delta: '第二段。' }),
      acc,
    );
    assert.equal(acc.thinking, '第一段。\n\n第二段。');
  });

  it('done 事件里的 summary 字段不会被当成增量', () => {
    const acc = newSseAcc();
    const out = applyResponsesEvent(
      JSON.stringify({
        type: 'response.reasoning_summary_text.done',
        summary_index: 0,
        text: '整段摘要',
      }),
      acc,
    );
    assert.equal(out.thinkingDelta, undefined);
    assert.equal(acc.thinking, '');
  });

  it('正文与思考走同一条累积器但互不干扰', () => {
    const acc = newSseAcc();
    applyResponsesEvent(JSON.stringify({ type: 'response.output_text.delta', delta: '回答' }), acc);
    applyResponsesEvent(
      JSON.stringify({ type: 'response.reasoning_summary_text.delta', summary_index: 0, delta: '思考' }),
      acc,
    );
    assert.equal(acc.text, '回答');
    assert.equal(acc.thinking, '思考');
  });
});

describe('toResponsesInput', () => {
  it('历史按 input items 摊平', () => {
    const items = toResponsesInput([
      { role: 'system', content: 'sys' },
      user('hi'),
      { role: 'assistant', content: 'yo', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: '{}' } }] },
      { role: 'tool', content: 'out', tool_call_id: 'c1' },
    ]);
    assert.equal(items[0]?.role, 'system');
    assert.equal(items[2]?.role, 'assistant');
    assert.equal(items[3]?.type, 'function_call');
    assert.equal(items[4]?.type, 'function_call_output');
  });

  it('默认回传 reasoning，且排在它引用的 function_call 之前', () => {
    const items = toResponsesInput([
      user('hi'),
      {
        role: 'assistant',
        content: '看目录',
        reasoning: [{ id: 'rs_1', encryptedContent: 'enc', summary: '先列目录' }],
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_dir', arguments: '{}' } }],
      },
    ]);
    assert.equal(items[1]?.type, 'reasoning');
    assert.equal(items[1]?.id, 'rs_1');
    assert.equal(items[1]?.encrypted_content, 'enc');
    assert.deepEqual(items[1]?.summary, [{ type: 'summary_text', text: '先列目录' }]);
    assert.equal(items[2]?.role, 'assistant');
    assert.equal(items[3]?.type, 'function_call');
  });

  it('没有摘要时仍发空 summary：上游把该字段列为必需，缺键直接 400', () => {
    const items = toResponsesInput([
      user('hi'),
      { role: 'assistant', content: 'x', reasoning: [{ id: 'rs_1', encryptedContent: 'enc' }] },
    ]);
    assert.equal(items[1]?.type, 'reasoning');
    assert.deepEqual(items[1]?.summary, []);
  });

  it('没有 encrypted_content 的推理项不回传：空壳重建不了状态', () => {
    const items = toResponsesInput([
      user('hi'),
      { role: 'assistant', content: 'x', reasoning: [{ id: 'rs_1' }] },
    ]);
    assert.equal(items.some((item) => item.type === 'reasoning'), false);
  });

  it('端点拒绝后（sendReasoning: false）不再回传 reasoning', () => {
    const items = toResponsesInput(
      [user('hi'), { role: 'assistant', content: 'x', reasoning: [{ id: 'rs_1', encryptedContent: 'enc' }] }],
      { ...DEFAULT_REQUEST_CAPS, sendReasoning: false },
    );
    assert.equal(items.some((item) => item.type === 'reasoning'), false);
  });
});

describe('applyResponsesEvent 非流式报文', () => {
  it('完整 response JSON（无 type 字段）按 completed 收下', () => {
    const acc = newSseAcc();
    applyResponsesEvent(
      JSON.stringify({
        object: 'response',
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }],
      }),
      acc,
    );
    const reply = finishStream(acc);
    assert.equal(reply.text, 'hi');
    assert.equal(reply.finishReason, 'stop');
  });
});

describe('applyResponsesEvent 审核拒绝与 incomplete', () => {
  it('response.refusal.delta 按正文收下', () => {
    const acc = newSseAcc();
    applyResponsesEvent(JSON.stringify({ type: 'response.refusal.delta', delta: 'cannot help with that' }), acc);
    assert.equal(finishStream(acc).text, 'cannot help with that');
  });

  it('incomplete_details.reason=content_filter 不再误报成 length', () => {
    const acc = newSseAcc();
    applyResponsesEvent(
      JSON.stringify({
        type: 'response.incomplete',
        response: { incomplete_details: { reason: 'content_filter' } },
      }),
      acc,
    );
    assert.equal(finishStream(acc).finishReason, 'incomplete:content_filter');
  });

  it('max_output_tokens / 缺省 reason 仍归一为 length', () => {
    for (const reason of ['max_output_tokens', undefined]) {
      const acc = newSseAcc();
      applyResponsesEvent(
        JSON.stringify({
          type: 'response.incomplete',
          response: reason === undefined ? {} : { incomplete_details: { reason } },
        }),
        acc,
      );
      assert.equal(finishStream(acc).finishReason, 'length');
    }
  });
});
