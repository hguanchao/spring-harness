import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateSessionTitle, sanitizeSessionTitle, SESSION_TITLE_MAX_CHARS } from './session-title.js';
import type { LlmClient, StreamDelta } from '../llm/openai.js';

function fakeClient(reply: string | Error, onCall?: (messages: Array<{ role: string; content: string }>) => void): LlmClient {
  return {
    async complete(messages) {
      if (onCall) onCall(messages as Array<{ role: string; content: string }>);
      if (reply instanceof Error) throw reply;
      return { text: reply } as StreamDelta;
    },
  } as LlmClient;
}

describe('sanitizeSessionTitle', () => {
  it('剥掉控制字符与 bidi 隔离符（OSC 净化面，对齐 codex terminal_title）', () => {
    assert.equal(sanitizeSessionTitle('fix\u001b]0;pwn\u202eauth'), 'fix]0;pwnauth');
    assert.equal(sanitizeSessionTitle('a\u2066b\u2069c'), 'abc');
  });

  it('`|` 是标题分隔符，出现即折成 `/`；空白折叠去首尾', () => {
    assert.equal(sanitizeSessionTitle('  fix   auth | bug \t'), 'fix auth / bug');
  });

  it('剥掉模型手滑包上的成对引号（弯引号一并处理）', () => {
    assert.equal(sanitizeSessionTitle('"fixing auth bug"'), 'fixing auth bug');
    assert.equal(sanitizeSessionTitle('“修登录 bug”'), '修登录 bug');
    assert.equal(sanitizeSessionTitle('"只有前引号'), '只有前引号');
  });

  it('超长截断到上限并去尾空格', () => {
    const title = sanitizeSessionTitle(`${'x'.repeat(60)}   tail`);
    assert.equal([...title].length, SESSION_TITLE_MAX_CHARS);
    assert.ok(!title.endsWith(' '));
  });
});

describe('generateSessionTitle', () => {
  it('拼 system + user 两段消息，标题经清洗返回', async () => {
    let seen: Array<{ role: string; content: string }> = [];
    const title = await generateSessionTitle(
      fakeClient('  "Fixing auth bug"  ', (messages) => { seen = messages; }),
      '帮我修登录 bug',
      '已修复 login.ts 的空指针。',
    );
    assert.equal(title, 'Fixing auth bug');
    assert.equal(seen.length, 2);
    assert.match(seen[0]!.content, /concise title/);
    assert.match(seen[1]!.content, /帮我修登录 bug/);
    assert.match(seen[1]!.content, /已修复 login\.ts/);
  });

  it('回复为空时只喂 user 一侧；两侧全空直接放弃，不发起调用', async () => {
    let calls = 0;
    const none = await generateSessionTitle(fakeClient('', () => { calls += 1; }), '   ', '');
    assert.equal(none, undefined);
    assert.equal(calls, 0);

    let seen: Array<{ role: string; content: string }> = [];
    await generateSessionTitle(fakeClient('t', (messages) => { seen = messages; }), '只改了个 typo', '');
    assert.equal(seen.length, 2);
    assert.ok(!seen[1]!.content.includes('assistant:'));
  });

  it('tools 选项透传给 complete（免费档网关按请求形态放行）；缺省为空数组', async () => {
    let seenTools: unknown;
    const client = {
      async complete(_messages: unknown, tools: unknown) {
        seenTools = tools;
        return { text: 't' };
      },
    } as LlmClient;
    const tools = [{ type: 'function', name: 'shell' }];
    await generateSessionTitle(client, 'p', 'r', { tools });
    assert.equal(seenTools, tools);
    await generateSessionTitle(client, 'p', 'r');
    assert.deepEqual(seenTools, []);
  });

  it('调用失败静默返回 undefined（标题是装饰，不打扰主流程）', async () => {
    const title = await generateSessionTitle(fakeClient(new Error('403')), 'prompt', 'reply');
    assert.equal(title, undefined);
  });

  it('用量经 onUsage 上报，走辅助记账', async () => {
    let usage: unknown;
    const client = {
      async complete() {
        return { text: 't', usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } };
      },
    } as LlmClient;
    await generateSessionTitle(client, 'p', 'r', { onUsage: (u) => { usage = u; } });
    assert.deepEqual(usage, { promptTokens: 1, completionTokens: 2, totalTokens: 3 });
  });
});
