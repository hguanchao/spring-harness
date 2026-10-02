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
import { runScriptedTurn } from '../../harness.js';

describe('unfinished stream continuations', () => {
	it('stops the turn after too many continuations with no progress', async () => {
		// 每跳只有思考、没有正文、没有 finish 原因 = 网关稳定掐断。
		const { client, saved, events } = await runScriptedTurn({ script: [{ thinking: 'reasoning…' }] });
		assert.ok(client.calls > 1, '第一次不该立刻停：要给瞬时断流留续写的机会');
		assert.ok(client.calls <= 5, `续写必须有上限，实际跑了 ${client.calls} 跳`);
		assert.ok(
			saved.events.some((e) => e.kind === 'stream_unfinished'),
			'每次续写都要落盘，否则会话里只剩一段没有解释的时间空洞',
		);
		assert.equal(
			saved.events.find((e) => e.kind === 'turn_end')?.data.finishReason,
			'unfinished',
			'收尾要标明不是正常结束',
		);
		assert.ok(
			events.some((e) => e.type === 'error' && e.text?.includes('no text and no tool calls')),
			'要给出人能读懂的原因，而不是静默停止',
		);
	});

	it('keeps going while the step produces text', async () => {
		// 有正文就算有进展：计数归零，不该被上限打断。
		const { client, saved } = await runScriptedTurn({
			script: [{ text: 'still writing', thinking: 'x' }, { text: 'done', finishReason: 'stop' }],
		});
		assert.equal(client.calls, 2);
		assert.equal(saved.events.find((e) => e.kind === 'turn_end')?.data.finishReason, 'stop');
	});
});
