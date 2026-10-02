/**
 * `run_code` / PTC：模型写代码调工具，只有输出回到上下文。
 *
 * 这里起**真的子进程**——不 mock spawn。这一层的价值全在「代码真的在别处跑、真的只能通过
 * RPC 产生副作用」上，把它 mock 掉等于把要验的东西删掉，剩下的断言只是在验 mock 自己。
 * 代价是每个用例几十到几百毫秒，所以用例数刻意压到能覆盖真实行为的量。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultTools, runCodeEnabled } from '@/plugins/sph-tools/index.js';
import { buildSystemPrompt } from '@/plugins/sph-loop/prompt.js';
import {
	callableManifest,
	clipProgramOutput,
	programToolResult,
	runProgram,
	type ProgramFailure,
	type ProgramResult,
} from '@/tools/ptc.js';

const MANIFEST = ['alpha', 'beta'];

/** 一个记账用的假工具后端：模拟宿主经关卡后的回包。 */
function backend(handlers: Record<string, (args: Record<string, unknown>) => { ok: boolean; content: string }>) {
	const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
	return {
		calls,
		invoke: async (tool: string, args: Record<string, unknown>) => {
			calls.push({ tool, args });
			const handler = handlers[tool];
			if (!handler) return { ok: false, content: `unknown tool: ${tool}` };
			return handler(args);
		},
	};
}

function expectOk(result: ProgramResult | ProgramFailure): ProgramResult {
	assert.ok(!('error' in result), `期望成功，实际失败：${'error' in result ? result.error : ''}`);
	return result as ProgramResult;
}

describe('run_code program execution', () => {
	it('runs a program that calls tools and returns only what it printed', async () => {
		// 三个文件各一大段内容，代码在沙箱里过滤，只把命中的那行交回来。
		const tool = backend({
			alpha: (args) => ({ ok: true, content: `noise-noise-${String(args.n)}\nHIT-${String(args.n)}` }),
		});
		const result = expectOk(
			await runProgram({
				code: `
					const hits = [];
					for (const n of [1, 2, 3]) {
						const out = await tools.alpha({ n });
						hits.push(out.split('\\n').find((line) => line.startsWith('HIT')));
					}
					text(hits.join(', '));
				`,
				manifest: ['alpha'],
				invoke: tool.invoke,
			}),
		);

		assert.equal(result.calls, 3, '三次调用都要真的发生');
		assert.equal(tool.calls.length, 3);
		assert.equal(result.output, 'HIT-1, HIT-2, HIT-3');
		assert.ok(
			!result.output.includes('noise-noise'),
			'中间结果不该回到上下文——这正是 run_code 存在的理由',
		);
	});

	it('rejects the promise on a failed tool call so the program can decide', async () => {
		const tool = backend({
			alpha: () => ({ ok: false, content: 'denied by the approval policy' }),
		});
		const result = expectOk(
			await runProgram({
				code: `
					let outcome = 'not-run';
					try { await tools.alpha({}); outcome = 'unexpectedly ok'; }
					catch (error) { outcome = 'caught: ' + error.message; }
					text(outcome);
				`,
				manifest: ['alpha'],
				invoke: tool.invoke,
			}),
		);
		assert.equal(result.output, 'caught: denied by the approval policy');
	});

	it('keeps going after a caught tool failure', async () => {
		// 一次失败不该终止整段程序：模型写了 try/catch 就该按它写的走。
		const tool = backend({
			alpha: (args) => (args.n === 2
				? { ok: false, content: 'boom' }
				: { ok: true, content: 'ok' }),
		});
		const result = expectOk(
			await runProgram({
				code: `
					const seen = [];
					for (const n of [1, 2, 3]) {
						try { seen.push(await tools.alpha({ n })); } catch { seen.push('ERR'); }
					}
					text(seen.join('/'));
				`,
				manifest: ['alpha'],
				invoke: tool.invoke,
			}),
		);
		assert.equal(result.output, 'ok/ERR/ok');
		assert.equal(result.calls, 3);
	});

	it('treats a returned value as output', async () => {
		const tool = backend({});
		const result = expectOk(await runProgram({ code: 'return 40 + 2;', manifest: MANIFEST, invoke: tool.invoke }));
		assert.equal(result.output, '42');
	});

	it('reports an empty program as no output rather than failing', async () => {
		const tool = backend({});
		const result = expectOk(await runProgram({ code: 'const x = 1;', manifest: MANIFEST, invoke: tool.invoke }));
		assert.equal(result.output, '');
		assert.equal(programToolResult(result).ok, true);
	});
});

describe('run_code containment', () => {
	it('cannot reach the host filesystem, process, or require', async () => {
		// vm 上下文里没有 process / require / fs / fetch。这不是「安全边界」的证明（vm 文档
		// 明确说不是），而是**能力边界的证明**：模型代码拿不到这些东西，因此产生副作用只剩
		// RPC 一条路。探针写成 `typeof <name>`：`typeof` 对未声明的名字不抛错，才是判据；
		// `eval('process')` 会抛 ReferenceError，那测的是探针自己。
		const tool = backend({});
		const result = expectOk(
			await runProgram({
				code: `
					const probe = (name) => eval('typeof ' + name);
					text([probe('process'), probe('require'), probe('fetch'), probe('globalThis.process')].join(','));
				`,
				manifest: MANIFEST,
				invoke: tool.invoke,
			}),
		);
		assert.equal(result.output, 'undefined,undefined,undefined,undefined');
	});

	it('refuses a tool that is not in the manifest, before reaching the host', async () => {
		const tool = backend({ alpha: () => ({ ok: true, content: 'should not happen' }) });
		const result = expectOk(
			await runProgram({
				code: `
					let message = 'not-run';
					try { await tools.gamma({}); } catch (error) { message = error.message; }
					text(message);
				`,
				manifest: ['alpha'],
				invoke: tool.invoke,
			}),
		);
		assert.ok(result.output.includes('not exposed to run_code'), result.output);
		assert.equal(tool.calls.length, 0, '清单外的名字不该走到宿主那边');
	});

	it('enforces a tool call ceiling', async () => {
		const tool = backend({ alpha: () => ({ ok: true, content: 'ok' }) });
		const result = await runProgram({
			code: `
				let message = 'not-run';
				try { for (let i = 0; i < 50; i++) await tools.alpha({}); } catch (error) { message = error.message; }
				text(message);
			`,
			manifest: ['alpha'],
			invoke: tool.invoke,
			maxCalls: 5,
		});
		const ok = expectOk(result);
		assert.ok(ok.output.includes('tool call limit reached (5)'), ok.output);
		assert.equal(ok.calls, 5, '上限之内允许的调用仍要执行完');
	});

	it('kills the child when the program overruns its timeout', async () => {
		const tool = backend({});
		const result = await runProgram({
			code: 'await sleep(60_000); text("too late");',
			manifest: MANIFEST,
			invoke: tool.invoke,
			timeoutMs: 400,
		});
		assert.ok('error' in result, '超时必须失败，而不是一直等');
		assert.ok((result as ProgramFailure).error.includes('timed out'), (result as ProgramFailure).error);
	});

	it('reports a syntax error with nothing executed', async () => {
		const tool = backend({});
		const result = await runProgram({
			code: 'text("before"); this is not javascript;',
			manifest: MANIFEST,
			invoke: tool.invoke,
		});
		assert.ok('error' in result);
		const failure = result as ProgramFailure;
		assert.ok(failure.error.length > 0, '要给出可读原因');
		assert.equal(failure.output, '', '语法错在编译期就抛，一行都不该执行');
		const rendered = programToolResult(failure);
		assert.equal(rendered.ok, false);
		assert.ok(!rendered.content.includes('Output before the failure'), '没跑过就不该编出一段「失败前的输出」');
	});

	it('carries what was printed before a runtime error', async () => {
		// 半截输出常常已经说明了问题（模型看到哪一步炸的就知道该改哪里）。
		const tool = backend({ alpha: () => ({ ok: true, content: 'first' }) });
		const result = await runProgram({
			code: `
				const first = await tools.alpha({});
				text('got ' + first);
				throw new Error('later step blew up');
			`,
			manifest: ['alpha'],
			invoke: tool.invoke,
		});
		assert.ok('error' in result);
		const rendered = programToolResult(result as ProgramFailure);
		assert.equal(rendered.ok, false);
		assert.ok(rendered.content.includes('later step blew up'), '要给出原因');
		assert.ok(rendered.content.includes('got first'), '失败前打印的内容必须一起交回');
	});
});

describe('run_code result shaping', () => {
	it('never exposes run_code itself in the manifest', () => {
		assert.deepEqual(callableManifest(['read', 'run_code', 'bash']), ['bash', 'read']);
	});

	it('reports the tool call count without counting them as content', () => {
		const rendered = programToolResult({ output: 'answer', calls: 2, durationMs: 5 });
		assert.equal(rendered.ok, true);
		assert.ok(rendered.content.startsWith('[2 tool calls]'));
		assert.ok(rendered.content.includes('answer'));
	});

	it('says so when the program produced nothing', () => {
		const rendered = programToolResult({ output: '', calls: 0, durationMs: 5 });
		assert.equal(rendered.content, '(no output)');
	});

	it('clips long output by keeping both ends', () => {
		// 头尾都留：输出常常是「表头 + 一堆行 + 结论」，砍掉尾巴会丢掉结论。
		const text = `HEAD${'m'.repeat(500)}TAIL`;
		const clipped = clipProgramOutput(text, 100);
		assert.ok(clipped.startsWith('HEAD'), '开头要留');
		assert.ok(clipped.endsWith('TAIL'), '结论那一行要留');
		assert.ok(clipped.includes('truncated'), '要说明被截断过');
		assert.ok(clipped.length <= 140, `裁剪后不该还很长：${clipped.length}`);
	});

	it('leaves short output alone', () => {
		assert.equal(clipProgramOutput('short', 100), 'short');
	});
});

describe('run_code registration', () => {
	it('is in the default tool table', () => {
		// 接线断言：README 与工具说明都写着它在那儿，改 tools 数组时最容易悄悄弄丢。
		assert.ok(defaultTools.find('run_code'), '默认工具表里必须有 run_code');
	});

	it('is dropped by the kill switch', () => {
		// 关不掉的开关比没有开关更坏——排查「是不是它引起的」时要真能关掉。
		assert.equal(runCodeEnabled({}), true, '默认开');
		assert.equal(runCodeEnabled({ SPH_RUN_CODE: 'off' }), false);
		assert.equal(runCodeEnabled({ SPH_RUN_CODE: 'OFF' }), false, '大小写不敏感');
		assert.equal(runCodeEnabled({ SPH_RUN_CODE: 'on' }), true, '不是 off 就是开');
	});

	it('is exclusive, explorable, and blocked in plan mode', () => {
		// 独占：它自己会派发一批内层调用，与别的工具交错更难解释。
		// 计划模式不放行：一次 run_code 里可能有写操作，外层整块拦掉才是安全的默认。
		assert.equal(defaultTools.isConcurrencySafe('run_code'), false);
		assert.equal(defaultTools.isExploreTool('run_code'), true);
		assert.equal(defaultTools.isPlanSafe('run_code'), false);
	});

	it('tells the model how to call it, and only when it can', () => {
		// 工具的可用性有两条独立的通道：schema（接口声明）与系统提示里那一段说明。
		// 说明丢了模型只知道有个叫 run_code 的工具、不知道要在代码里 await tools.x()；
		// 说明没跟着工具集收窄，受限会话就会读到指向不可用工具的指令。
		const tool = defaultTools.find('run_code')!;
		const prompt = buildSystemPrompt({
			workspaceRoot: '/tmp/ws',
			sandbox: 'off',
			skills: [],
			toolPrompts: [{ tool: 'run_code', text: tool.prompt ?? tool.description }],
		});
		assert.ok(prompt.includes('tools.<name>'), '要讲清调用约定');
		assert.ok(prompt.includes('text('), '要讲清输出怎么写');

		const restricted = buildSystemPrompt({
			workspaceRoot: '/tmp/ws',
			sandbox: 'off',
			skills: [],
			allowedTools: new Set(['read']),
			toolPrompts: [{ tool: 'run_code', text: tool.prompt ?? tool.description }],
		});
		assert.ok(!restricted.includes('tools.<name>'), '工具不可用时，那段说明必须整段消失');
	});

	it('declares code as required in its schema', () => {
		// schema 是接口那一侧的契约：没有 required，模型可以发一次空调用，白跑一个来回。
		const schema = defaultTools.find('run_code')!.schema as { required?: string[]; properties?: Record<string, unknown> };
		assert.deepEqual(schema.required, ['code']);
		assert.ok(schema.properties?.code, 'code 要有说明，模型靠它知道这里写的是什么');
	});
});
