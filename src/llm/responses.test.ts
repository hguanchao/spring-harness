import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyResponsesEvent, buildResponsesRequest, toResponsesInput } from './responses.js';
import { newSseAcc } from './openai.js';
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
});
