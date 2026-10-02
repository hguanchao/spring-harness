/**
 * 循环对「流没有 finish 原因」的处置。
 *
 * 这条路径是给瞬时断流准备的：半截思考已经上屏，续写比重流一遍好。但网关若**稳定**掐断，
 * 而模型每次只吐思考、不出正文（正文与工具调用都为空），续写就是无底洞——实测一轮连烧两次
 * 各 6 分钟、各 40K 字思考，根会话的 turnLimit 是 undefined，没有任何东西兜底。
 *
 * 这里钉两件事：**没有进展的续写有上限**、**有进展就重新计数**。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SessionPort } from '@/session/types.js';
import { ToolRegistry } from '@/tools/registry.js';
import { runTurn } from '@/plugins/sph-loop/loop.js';

interface Reply {
	thinking?: string;
	text?: string;
	finishReason?: string;
}

/** 每跳按脚本回一帧；脚本用完就重复最后一帧。 */
const scriptedClient = (script: Reply[], calls: { n: number }) => ({
	complete: async (
		_messages: unknown,
		_tools: unknown,
		_signal?: AbortSignal,
		onDelta?: (delta: { text?: string; thinking?: string }) => void,
	) => {
		const reply = script[Math.min(calls.n, script.length - 1)] ?? {};
		calls.n += 1;
		if (reply.thinking) onDelta?.({ thinking: reply.thinking });
		if (reply.text) onDelta?.({ text: reply.text });
		return { text: reply.text ?? '', thinking: reply.thinking, finishReason: reply.finishReason, toolCalls: undefined };
	},
});

const makeSession = (): { session: SessionPort; events: { kind: string; data: Record<string, unknown> }[] } => {
	const events: { kind: string; data: Record<string, unknown> }[] = [];
	const session = {
		id: 't',
		dir: '',
		append() {},
		appendMessage() {},
		appendEvent(kind: string, data: Record<string, unknown>) {
			events.push({ kind, data });
		},
		readAll: () => [],
		readMessages: () => [],
	} as unknown as SessionPort;
	return { session, events };
};

const run = async (script: Reply[]) => {
	const calls = { n: 0 };
	const { session, events } = makeSession();
	const seen: { type: string; text?: string }[] = [];
	await runTurn({
		prompt: 'hi',
		workspaceRoot: process.cwd(),
		client: scriptedClient(script, calls) as never,
		session,
		tools: new ToolRegistry(),
		sandbox: { status: { mode: 'off' } } as never,
		approver: (async () => ({ approved: true })) as never,
		contextWindow: 256000,
		// 循环要求会话工厂在场（子代理派生走它）；本用例不派生子代理，给个占位实现。
		sessions: { create: () => session, open: () => session, resumeOrCreate: async () => session } as never,
		jobs: {
			startTask: () => '',
			onTaskDone: () => () => {},
			drainNotifications: () => [],
		} as never,
		memory: { noteTouch() {}, drain: () => [] },
		// 兜底超时：没有上限的续写是死循环，这里让它变成一条失败的断言而不是挂住测试进程。
		signal: AbortSignal.timeout(10_000),
		listener: (event) => seen.push(event as never),
	});
	return { calls: calls.n, events, seen };
};

describe('unfinished stream continuations', () => {
	it('stops the turn after too many continuations with no progress', async () => {
		// 每跳只有思考、没有正文、没有 finish 原因 = 网关稳定掐断。
		const { calls, events, seen } = await run([{ thinking: 'reasoning…' }]);
		assert.ok(calls > 1, '第一次不该立刻停：要给瞬时断流留续写的机会');
		assert.ok(calls <= 5, `续写必须有上限，实际跑了 ${calls} 跳`);
		assert.ok(
			events.some((e) => e.kind === 'stream_unfinished'),
			'每次续写都要落盘，否则会话里只剩一段没有解释的时间空洞',
		);
		assert.equal(
			events.find((e) => e.kind === 'turn_end')?.data.finishReason,
			'unfinished',
			'收尾要标明不是正常结束',
		);
		assert.ok(
			seen.some((e) => e.type === 'error' && e.text?.includes('no text and no tool calls')),
			'要给出人能读懂的原因，而不是静默停止',
		);
	});

	it('keeps going while the step produces text', async () => {
		// 有正文就算有进展：计数归零，不该被上限打断。
		const { calls, events } = await run([{ text: 'still writing', thinking: 'x' }, { text: 'done', finishReason: 'stop' }]);
		assert.equal(calls, 2);
		assert.equal(events.find((e) => e.kind === 'turn_end')?.data.finishReason, 'stop');
	});
});
