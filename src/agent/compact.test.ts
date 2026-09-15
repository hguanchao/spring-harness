import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChatMessage } from '../llm/openai.js';
import type { SessionMessage } from '../session/types.js';
import {
  estimateTokens,
  emptyWire,
  flushWireImages,
  pairingBalancedCut,
  pushSessionMessage,
  toChatMessages,
} from './compact.js';

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
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      },
      { role: 'tool', content: 'a', tool_call_id: 'c1', name: 'read_file' },
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
        toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.png' } }],
      }),
      session({
        role: 'tool',
        content: 'img',
        toolCallId: 'c1',
        toolName: 'read_file',
        images: ['data:image/png;base64,xx'],
      }),
      session({ role: 'assistant', content: 'done' }),
    ];
    const full = toChatMessages(rows);
    const state = emptyWire();
    for (const row of rows) pushSessionMessage(state, row);
    flushWireImages(state);
    assert.deepEqual(state.messages, full);
  });

  it('assistant 的 reasoning 进 wire，下一轮才能回传', () => {
    const rows = [
      session({ role: 'user', content: 'hi' }),
      session({
        role: 'assistant',
        content: '看',
        toolCalls: [{ id: 'c1', name: 'list_dir', arguments: { path: '.' } }],
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
