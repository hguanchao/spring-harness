/**
 * `run_code` 接到循环上的接线：内层调用真的走**同一套关卡**。
 *
 * 这是整个 PTC 设计里唯一承重的那条断言。`run_code` 让模型用代码批量调工具，如果那些内层
 * 调用走的是另一条路（直接 `tool.execute`），那么「把命令包进 run_code」就是一条绕开审批的
 * 捷径，权限模型随之只剩名义。所以这里用真循环、真规则、真审批器验一遍，而不是只验
 * `ptc.ts` 自己的行为。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readFileTool } from '@/plugins/sph-tools/read-file.js';
import { createRunCodeTool } from '@/plugins/sph-tools/run-code.js';
import { EMPTY_RULES } from '@/permission/policy.js';
import { runScriptedTurn } from '../../harness.js';
import type { ToolSpec } from '@/tools/types.js';

/** 一小块工作区，里面有一个真实文件供 `read` 读。 */
function withWorkspace<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), 'sph-ptc-'));
	writeFileSync(join(dir, 'notes.txt'), 'alpha\nbeta\ngamma\n', 'utf8');
	return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** 调用 run_code 的脚本帧。 */
function runCodeCall(code: string) {
	return {
		id: 'c1',
		name: 'run_code',
		arguments: { code },
	};
}

describe('run_code inside a turn', () => {
	it('executes inner tool calls and returns only what the program printed', async () => {
		await withWorkspace(async (dir) => {
			const { saved } = await runScriptedTurn({
				tools: [readFileTool, createRunCodeTool()],
				overrides: { workspaceRoot: dir },
				script: [
					{
						toolCalls: [
							runCodeCall(`
								const raw = await tools.read({ path: 'notes.txt' });
								text(raw.split('\\n').filter((line) => line.includes('beta')).join(''));
							`),
						],
					},
					{ text: 'done', finishReason: 'stop' },
				],
			});

			const toolResult = saved.messages.find((m) => m.role === 'tool');
			assert.ok(toolResult, 'run_code 必须作为工具结果落盘');
			assert.ok(toolResult.content.includes('beta'), '程序打印的内容要交回模型');
			assert.ok(
				!toolResult.content.includes('alpha'),
				`没打印的内容不该回来（这正是它省上下文的地方）：${toolResult.content}`,
			);
		});
	});

	it('applies the same approval gate to a call made from code', async () => {
		// 规则要求 read 先问，审批器一律拒绝。程序里那次 read 必须被挡住——
		// 挡不住就说明「包进 run_code」是一条绕开审批的路。
		await withWorkspace(async (dir) => {
			let approvals = 0;
			const { saved } = await runScriptedTurn({
				tools: [readFileTool, createRunCodeTool()],
				overrides: {
					workspaceRoot: dir,
					rules: { user: { rules: { ...EMPTY_RULES, ask: ['read'] }, sourceDir: dir } },
					ruleEnv: { workspaceRoot: dir, home: dir },
					approver: {
						decide: async () => {
							approvals += 1;
							return false;
						},
					},
				},
				script: [
					{
						toolCalls: [
							runCodeCall(`
								let outcome = 'ran';
								try { await tools.read({ path: 'notes.txt' }); }
								catch (error) { outcome = 'blocked'; }
								text(outcome);
							`),
						],
					},
					{ text: 'done', finishReason: 'stop' },
				],
			});

			assert.equal(approvals, 1, '内层调用必须请示审批器，次数与顶层调用相同');
			const toolResult = saved.messages.find((m) => m.role === 'tool');
			assert.ok(toolResult?.content.includes('blocked'), `内层调用被拒后程序要能看见：${toolResult?.content}`);
			assert.ok(
				!toolResult?.content.includes('alpha'),
				'被拒的读取绝不能把内容带回来',
			);
		});
	});

	it('runs the inner call when the approver allows it', async () => {
		// 上一条的反面：同一套规则、审批器放行，内容就该真的回来。
		// 两条一起才说明关卡是「判」出来的，不是一律拦死。
		await withWorkspace(async (dir) => {
			const { saved } = await runScriptedTurn({
				tools: [readFileTool, createRunCodeTool()],
				overrides: {
					workspaceRoot: dir,
					rules: { user: { rules: { ...EMPTY_RULES, ask: ['read'] }, sourceDir: dir } },
					ruleEnv: { workspaceRoot: dir, home: dir },
					approver: { decide: async () => true },
				},
				script: [
					{
						toolCalls: [
							runCodeCall(`
								const raw = await tools.read({ path: 'notes.txt' });
								text('last line: ' + raw.trim().split('\\n').at(-1).trim());
							`),
						],
					},
					{ text: 'done', finishReason: 'stop' },
				],
			});
			const toolResult = saved.messages.find((m) => m.role === 'tool');
			assert.ok(
				toolResult?.content.includes('gamma'),
				`放行之后读到的内容要真的回来：${toolResult?.content}`,
			);
		});
	});

	it('refuses to let a program call run_code again', async () => {
		// 递归无上限：清单里没有它，宿主那一侧也再判一次。
		await withWorkspace(async (dir) => {
			const { saved } = await runScriptedTurn({
				tools: [readFileTool, createRunCodeTool()],
				overrides: { workspaceRoot: dir },
				script: [
					{
						toolCalls: [
							runCodeCall(`
								let outcome = 'ran';
								try { await tools.run_code({ code: 'text(1)' }); }
								catch (error) { outcome = error.message; }
								text(outcome);
							`),
						],
					},
					{ text: 'done', finishReason: 'stop' },
				],
			});
			const toolResult = saved.messages.find((m) => m.role === 'tool');
			assert.ok(toolResult?.content.includes('not exposed to run_code'), toolResult?.content);
		});
	});

	it('refuses a tool that this agent is not allowed to call', async () => {
		// 受限会话（只读子代理那类）里，run_code 的暴露清单跟着收窄，
		// 不能因为「代码里调的」就把允许名单绕过去。
		await withWorkspace(async (dir) => {
			const writer: ToolSpec = {
				name: 'write_secret',
				description: 'should never be reachable',
				schema: { type: 'object', properties: {} },
				async execute() {
					return { ok: true, content: 'SIDE-EFFECT-HAPPENED' };
				},
			};
			const { saved } = await runScriptedTurn({
				tools: [readFileTool, writer, createRunCodeTool()],
				overrides: {
					workspaceRoot: dir,
					allowedTools: new Set(['read', 'run_code']),
				},
				script: [
					{
						toolCalls: [
							runCodeCall(`
								let outcome = 'ran';
								try { await tools.write_secret({}); }
								catch (error) { outcome = error.message; }
								text(outcome);
							`),
						],
					},
					{ text: 'done', finishReason: 'stop' },
				],
			});
			const toolResult = saved.messages.find((m) => m.role === 'tool');
			assert.ok(toolResult?.content.includes('not exposed to run_code'), toolResult?.content);
			assert.ok(
				!toolResult?.content.includes('SIDE-EFFECT-HAPPENED'),
				'名单外的工具绝不能被执行',
			);
		});
	});
});
