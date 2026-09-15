import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MIN_TURNS_FOR_AUTO_RECAP,
  RECAP_AUTO_RAW_DISPLAY_MAX,
  RECAP_MAX_CHARS,
  buildRecapRequest,
  cleanRecapText,
  generateRecap,
  isSyntheticUserMessage,
  mainTurnCount,
  popTrailingToolRun,
  recapGate,
  recapInstruction,
  shouldSuppressAutoRecapDisplay,
} from './recap.js';
import type { ChatMessage, LlmClient, StreamDelta } from '../llm/openai.js';
import type { SessionMessage } from '../session/types.js';

function user(content: string): SessionMessage {
  return { type: 'message', ts: '2026-01-01T00:00:00.000Z', role: 'user', content };
}

function assistant(content: string): SessionMessage {
  return { type: 'message', ts: '2026-01-01T00:00:00.000Z', role: 'assistant', content };
}

describe('cleanRecapText', () => {
  it('collapses whitespace and newlines into one line', () => {
    assert.equal(
      cleanRecapText('Refactored   the\n\nparser\tand added   tests.'),
      'Refactored the parser and added tests.',
    );
  });

  it('strips a stray leading label the model added anyway', () => {
    assert.equal(cleanRecapText('Recap: fixed the auth bug'), 'fixed the auth bug');
    assert.equal(cleanRecapText('Recap — wired up the API'), 'wired up the API');
    assert.equal(cleanRecapText('Session recap: added tests'), 'added tests');
  });

  it('strips symmetric wrapping quotes', () => {
    assert.equal(cleanRecapText('"did the thing"'), 'did the thing');
    assert.equal(cleanRecapText("'did the thing'"), 'did the thing');
    // 只有一边有引号时不动它——那可能是正文的一部分。
    assert.equal(cleanRecapText('"half quoted'), '"half quoted');
  });

  it('caps runaway output on a code point boundary', () => {
    const out = cleanRecapText('word '.repeat(RECAP_MAX_CHARS));
    assert.ok(out.length <= RECAP_MAX_CHARS + 4, `len was ${out.length}`);
    assert.ok(out.endsWith('…'));
  });

  it('never splits a surrogate pair when capping', () => {
    const out = cleanRecapText('😀'.repeat(RECAP_MAX_CHARS));
    assert.ok(out.endsWith('…'));
    // 落单的代理项会让最后两个 UTF-16 单元凑不成一个码点。
    const body = out.slice(0, -1);
    const tail = body.charCodeAt(body.length - 1);
    assert.ok(!(tail >= 0xd800 && tail <= 0xdbff), 'cap left a lone high surrogate');
  });

  it('keeps a normal recap in full', () => {
    const recap =
      'We fixed the flaky integration test by awaiting the drain channel before exit, ' +
      'added a regression test for the shutdown path, and updated the runbook.';
    const out = cleanRecapText(recap);
    assert.ok(out.length < RECAP_MAX_CHARS);
    assert.ok(!out.endsWith('…'));
    assert.equal(out, recap);
  });
});

describe('mainTurnCount', () => {
  it('counts real user prompts only', () => {
    const messages = [user('hi'), assistant('hello'), user('again')];
    assert.equal(mainTurnCount(messages), 2);
  });

  it('ignores runtime-injected user turns', () => {
    const messages = [
      user('fix it'),
      user('[background task completed: npm test]\nok'),
      user('[message from parent session]\nkeep going'),
      user('[instructions from AGENTS.md]\nuse tabs'),
      user('and also this'),
    ];
    assert.equal(mainTurnCount(messages), 2);
  });

  it('counts a tool loop as one turn', () => {
    const messages: SessionMessage[] = [
      user('fix it'),
      assistant(''),
      { type: 'message', ts: '2026-01-01T00:00:00.000Z', role: 'tool', content: 'ok', toolCallId: 'c1' },
      assistant('done'),
    ];
    assert.equal(mainTurnCount(messages), 1);
  });

  it('reports zero for an empty session', () => {
    assert.equal(mainTurnCount([]), 0);
  });

  it('recognises each synthetic prefix', () => {
    assert.ok(isSyntheticUserMessage('[background task FAILED: x]\nboom'));
    assert.ok(isSyntheticUserMessage('[message from parent session]\nhi'));
    assert.ok(isSyntheticUserMessage('[instructions from a/b.md]\nhi'));
    assert.ok(!isSyntheticUserMessage('hello'));
  });
});

describe('recapGate', () => {
  it('denies a session with no main turns, manual or auto', () => {
    assert.deepEqual(recapGate(0, 0, false, true), { ok: false, reason: 'no main turns yet' });
    assert.deepEqual(recapGate(0, 0, true, true), { ok: false, reason: 'no main turns yet' });
  });

  it('lets a manual recap through on any main turn, even the same one twice', () => {
    assert.deepEqual(recapGate(1, 0, false, false), { ok: true });
    assert.deepEqual(recapGate(3, 3, false, false), { ok: true });
  });

  it('denies a second auto recap on the same main turn', () => {
    assert.deepEqual(recapGate(3, 3, true, true), {
      ok: false,
      reason: 'no new main turn since last recap',
    });
  });

  it('requires the auto turn floor', () => {
    assert.deepEqual(recapGate(MIN_TURNS_FOR_AUTO_RECAP - 1, 0, true, true), {
      ok: false,
      reason: 'fewer than min turns for auto recap',
    });
    assert.deepEqual(recapGate(MIN_TURNS_FOR_AUTO_RECAP, 0, true, true), { ok: true });
  });

  it('requires the idle threshold for auto only', () => {
    assert.deepEqual(recapGate(3, 0, true, false), { ok: false, reason: 'idle threshold not met' });
    assert.deepEqual(recapGate(3, 0, false, false), { ok: true });
  });

  it('allows an auto recap after a new main turn', () => {
    assert.deepEqual(recapGate(4, 3, true, true), { ok: true });
  });
});

describe('shouldSuppressAutoRecapDisplay', () => {
  it('keeps a normal auto recap', () => {
    const raw = 'We fixed the flaky integration test: race in queue_worker shutdown.';
    assert.ok(raw.length < RECAP_AUTO_RAW_DISPLAY_MAX);
    assert.equal(shouldSuppressAutoRecapDisplay(raw, cleanRecapText(raw)), false);
  });

  it('suppresses a runaway raw tail', () => {
    const raw = 'Creating the PR from the worktree. '.repeat(20);
    assert.ok(raw.length > RECAP_AUTO_RAW_DISPLAY_MAX);
    assert.equal(shouldSuppressAutoRecapDisplay(raw, cleanRecapText(raw)), true);
  });

  it('suppresses output that hit the hard cap', () => {
    const raw = 'word '.repeat(RECAP_MAX_CHARS);
    const summary = cleanRecapText(raw);
    assert.ok(summary.endsWith('…'));
    assert.equal(shouldSuppressAutoRecapDisplay(raw, summary), true);
  });
});

describe('popTrailingToolRun', () => {
  const call = (id: string): ChatMessage => ({
    role: 'assistant',
    content: '',
    tool_calls: [{ id, type: 'function', function: { name: 'shell', arguments: '{}' } }],
  });

  it('drops a dangling tool run so the instruction never follows a tool_use', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      call('c1'),
      { role: 'tool', content: 'out', tool_call_id: 'c1', name: 'shell' },
    ];
    popTrailingToolRun(messages);
    assert.deepEqual(messages, [{ role: 'user', content: 'hi' }]);
  });

  it('drops a tool result image that follows the tool run', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      call('c1'),
      { role: 'tool', content: 'out', tool_call_id: 'c1', name: 'read_file' },
      { role: 'user', content: '[tool result image]' },
    ];
    popTrailingToolRun(messages);
    assert.deepEqual(messages, [{ role: 'user', content: 'hi' }]);
  });

  it('leaves a clean tail untouched', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'done' },
    ];
    popTrailingToolRun(messages);
    assert.equal(messages.length, 2);
  });
});

describe('buildRecapRequest', () => {
  it('puts the system prompt first and the instruction last', () => {
    const messages = buildRecapRequest({
      messages: [user('hello'), assistant('hi')],
      system: 'sys',
      contextWindow: 256_000,
    });
    assert.deepEqual(messages[0], { role: 'system', content: 'sys' });
    assert.equal(messages.length, 4);
    const last = messages.at(-1);
    assert.equal(last?.role, 'user');
    assert.ok(last?.content.includes('Write ONE sentence recap body'));
  });

  it('never leaves a dangling tool run before the instruction', () => {
    // 中途快照的真实形状：assistant 发起了工具调用，结果还没回来。
    const messages = buildRecapRequest({
      messages: [
        user('hello'),
        {
          type: 'message',
          ts: '2026-01-01T00:00:00.000Z',
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'shell', arguments: { command: 'ls' } }],
        },
      ],
      system: 'sys',
      contextWindow: 256_000,
    });
    assert.deepEqual(
      messages.map((message) => message.role),
      ['system', 'user', 'user'],
    );
    assert.ok(!messages.some((message) => message.tool_calls !== undefined));
  });

  it('keeps the conversation verbatim when it fits the budget', () => {
    const history = [user('q1'), assistant('a1'), user('q2')];
    const messages = buildRecapRequest({ messages: history, system: 'sys', contextWindow: 256_000 });
    assert.deepEqual(messages[1], { role: 'user', content: 'q1' });
    assert.deepEqual(messages[2], { role: 'assistant', content: 'a1' });
    assert.deepEqual(messages[3], { role: 'user', content: 'q2' });
  });

  it('drops whole oldest turns when over budget, keeping the newest user turn', () => {
    const messages = buildRecapRequest({
      messages: [user('x'.repeat(40_000)), assistant('a1'), user('what changed in the parser?')],
      system: 'sys',
      contextWindow: 8_000,
    });
    assert.equal(messages[0]?.role, 'system');
    assert.equal(messages.at(-1)?.role, 'user');
    assert.ok(messages.at(-1)?.content.includes('Write ONE sentence'));
    assert.ok(
      messages.some((message) => message.content.includes('what changed in the parser?')),
      'the most recent real user turn must survive the trim',
    );
    assert.ok(
      !messages.some((message) => message.content.startsWith('x'.repeat(100))),
      'the oversized oldest turn must be dropped',
    );
  });

  it('truncates a single oversized turn in place instead of dropping it', () => {
    const messages = buildRecapRequest({
      messages: [user('y'.repeat(200_000))],
      system: 'sys',
      contextWindow: 8_000,
    });
    assert.equal(messages.length, 3);
    const kept = messages[1];
    assert.equal(kept?.role, 'user');
    assert.ok(kept?.content.endsWith('…[truncated]'));
    assert.ok((kept?.content.length ?? 0) < 200_000);
  });

  it('carries an existing compaction summary into the snapshot', () => {
    const messages = buildRecapRequest({
      messages: [user('old'), user('new')],
      compaction: { summary: 'earlier work', covered: 1 },
      system: 'sys',
      contextWindow: 256_000,
    });
    assert.equal(messages[1]?.content, '[compacted earlier context]\nearlier work');
  });
});

describe('generateRecap', () => {
  const stub = (reply: Partial<StreamDelta>): { client: LlmClient; seen: ChatMessage[][] } => {
    const seen: ChatMessage[][] = [];
    return {
      seen,
      client: {
        complete: (messages: ChatMessage[]) => {
          seen.push(messages);
          return Promise.resolve({ text: '', ...reply });
        },
      },
    };
  };

  it('sends no tools and returns the cleaned body', async () => {
    const { client, seen } = stub({ text: 'Recap: We added the /recap command.\n' });
    const result = await generateRecap(
      { messages: [user('hi')], system: 'sys', contextWindow: 256_000 },
      { client },
    );
    assert.equal(result.summary, 'We added the /recap command.');
    assert.equal(result.raw, 'Recap: We added the /recap command.\n');
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.at(-1)?.content, recapInstruction());
  });

  it('reports auxiliary usage without touching the conversation', async () => {
    const { client } = stub({
      text: 'We did the thing.',
      usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
    });
    const usages: number[] = [];
    await generateRecap(
      { messages: [user('hi')], system: 'sys', contextWindow: 256_000 },
      { client, onUsage: (usage) => usages.push(usage.promptTokens) },
    );
    assert.deepEqual(usages, [10]);
  });

  it('throws when the model returns nothing usable', async () => {
    const { client } = stub({ text: '   \n  ' });
    await assert.rejects(
      () => generateRecap({ messages: [user('hi')], system: 'sys', contextWindow: 256_000 }, { client }),
      /empty recap summary/,
    );
  });
});
