/**
 * 工具调用的一段：调用 → 执行 → 结果进下一轮提示。
 *
 * 钉的是「落盘的东西真的出现在下一轮请求里」——工具结果只写进会话文件而没进投影，
 * 或进了投影但顺序错了，都是在真实使用中极难自查的故障：模型不会报错，它只会开始
 * 表现得像是没看见工具的输出。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ToolSpec } from '@/tools/types.js';
import { runScriptedTurn } from '../../harness.js';

/** 记下每次调用，按参数回显；`concurrencySafe` 让同一步里的调用可以并行。 */
function recordingTool(name: string, invocations: Array<Record<string, unknown>>, concurrencySafe = false): ToolSpec {
	return {
		name,
		description: `test tool ${name}`,
		schema: { type: 'object', properties: { value: { type: 'string' } } },
		concurrencySafe,
		async execute(args) {
			invocations.push(args);
			return { ok: true, content: `${name} saw ${String(args.value)}` };
		},
	};
}

describe('tool batch in a turn', () => {
	it('carries the tool result into the next request', async () => {
		const seen: Array<Record<string, unknown>> = [];
		const { client, saved } = await runScriptedTurn({
			tools: [recordingTool('probe', seen)],
			script: [
				{ toolCalls: [{ id: 'c1', name: 'probe', arguments: { value: 'first' } }] },
				{ text: 'done', finishReason: 'stop' },
			],
		});

		assert.deepEqual(seen, [{ value: 'first' }], '工具必须被执行一次');
		assert.equal(client.calls, 2, '模型要在拿到结果后再被问一次');
		const secondRequest = client.seenMessages[1]!.map((m) => m.content).join('\n');
		assert.ok(secondRequest.includes('probe saw first'), '工具结果必须进到下一轮提示里');
		assert.ok(
			saved.messages.some((m) => m.role === 'tool' && m.content === 'probe saw first'),
			'工具结果同时要落盘，恢复会话才有它',
		);
	});

	it('commits parallel results in the model order, not the completion order', async () => {
		const seen: Array<Record<string, unknown>> = [];
		// 第一个调用故意慢：并行执行时它后完成，但结果必须排在前面。
		const slow: ToolSpec = {
			name: 'slow',
			description: 'slow tool',
			schema: { type: 'object', properties: {} },
			concurrencySafe: true,
			async execute() {
				await new Promise((resolve) => setTimeout(resolve, 30));
				return { ok: true, content: 'slow result' };
			},
		};
		const { saved } = await runScriptedTurn({
			tools: [slow, recordingTool('fast', seen, true)],
			script: [
				{
					toolCalls: [
						{ id: 'c1', name: 'slow', arguments: {} },
						{ id: 'c2', name: 'fast', arguments: { value: 'x' } },
					],
				},
				{ text: 'done', finishReason: 'stop' },
			],
		});

		const results = saved.messages.filter((m) => m.role === 'tool').map((m) => m.content);
		assert.deepEqual(
			results,
			['slow result', 'fast saw x'],
			'结果顺序必须跟模型给的工具调用顺序一致，否则模型会把参数配错结果',
		);
	});

	it('reports a tool that throws as a failed result instead of killing the turn', async () => {
		const exploding: ToolSpec = {
			name: 'explode',
			description: 'always throws',
			schema: { type: 'object', properties: {} },
			async execute() {
				throw new Error('boom');
			},
		};
		const { client, saved } = await runScriptedTurn({
			tools: [exploding],
			script: [
				{ toolCalls: [{ id: 'c1', name: 'explode', arguments: {} }] },
				{ text: 'recovered', finishReason: 'stop' },
			],
		});

		assert.equal(client.calls, 2, '工具抛错不该终止这一轮');
		const failure = saved.messages.find((m) => m.role === 'tool');
		assert.ok(failure, '失败也要作为工具结果落盘');
		assert.ok(failure.content.includes('boom'), '失败原因要交给模型，否则它只会重试同一个调用');
	});

	it('answers an unknown tool name without executing anything', async () => {
		const { client, saved } = await runScriptedTurn({
			script: [
				{ toolCalls: [{ id: 'c1', name: 'nonexistent', arguments: {} }] },
				{ text: 'ok', finishReason: 'stop' },
			],
		});

		assert.equal(client.calls, 2);
		const failure = saved.messages.find((m) => m.role === 'tool');
		assert.ok(failure?.content.toLowerCase().includes('nonexistent'), '要说清是哪个名字不认识');
	});
});
