/**
 * `run_code`：模型写一段 JS，在沙箱里调工具，只有输出回到上下文。
 *
 * 工具契约层面它很薄——真正干活的是 `src/tools/ptc.ts`（子进程 + vm + RPC）和宿主的
 * `ctx.invokeTool`（同一套关卡）。这里只负责：给模型一份读写说明、把清单交下去、
 * 把结果包装成普通的 ToolResult。
 *
 * 新增第 9 个运行时依赖：零。子进程跑的是 sph 自己的 `process.execPath`。
 */

import { runProgram, programToolResult, callableManifest } from '../../tools/ptc.js';
import type { ToolResult, ToolSpec } from '../../tools/types.js';

/**
 * 暴露给代码的工具集。
 *
 * **不含 `run_code` 自身**（递归无上限）、**不含 `task`**（子代理的提示词与预算由宿主管，
 * 从代码里派生会让「一步里有几个子代理」失去可见性）。`ask_user` 与 `todo` 也排除：
 * 前者会卡住等待真人输入，后者是同进程共享清单，在沙箱里写它等于绕开循环的可见性。
 */
const EXCLUDED = new Set(['run_code', 'task', 'ask_user', 'todo', 'send_subagent_message']);

function manifest(names: readonly string[]): string[] {
	return callableManifest(names.filter((name) => !EXCLUDED.has(name)));
}

/**
 * 面向模型的说明。
 *
 * **不列工具名**：模型自己的工具表里已经有那些名字与 schema，再抄一份既冗余又会过期
 * （清单随允许名单、计划模式、插件开关逐回合变，而这段文字是注册期就固定的）。
 * 这里只需要讲清「换一种调用方式」这件事。
 */
const PROMPT = [
	'Run a JavaScript program that calls tools directly, instead of calling them one at a time.',
	'Only what the program prints comes back to you — intermediate tool results never enter the conversation.',
	'That makes this the cheap way to search widely and then narrow down, or to repeat the same call over a list.',
	'',
	'The same tools you can call directly are available here as `await tools.<name>({ ...args })`. Helpers:',
	'  text(...parts)  append a line to the output',
	'  json(value)     append pretty-printed JSON',
	'  console.log     same as text()',
	'  sleep(ms)       await a delay',
	'Returning a value also appends it to the output.',
	'',
	'A failed tool call rejects the promise, so wrap it in try/catch when one failure should not end the program.',
	'A single call is cheaper made directly; reach for this when the task is many calls or would otherwise',
	'move a lot of data through the conversation just to filter it.',
].join('\n');

export function createRunCodeTool(): ToolSpec {
	return {
		name: 'run_code',
		description:
			'Run a JavaScript program that calls tools directly; only the program\'s output returns to the conversation.',
		schema: {
			type: 'object',
			properties: {
				code: {
					type: 'string',
					description:
						'An async function body. `await tools.<name>({...})` calls a tool; text()/console.log() write to the output.',
				},
			},
			required: ['code'],
		},
		// 同一批里可以和别的只读工具并行；独占也行，但它自身可能触发多个内层调用，
		// 让它们与别的工具交错反而更难解释。
		concurrencySafe: false,
		explore: true,
		planSafe: false,
		async execute(args, ctx): Promise<ToolResult> {
			const code = args.code;
			if (typeof code !== 'string' || code.trim() === '') {
				return { ok: false, content: 'code is required: an async function body that calls tools' };
			}
			if (!ctx.invokeTool) {
				return {
					ok: false,
					content: 'run_code is unavailable in this host: tool dispatch is not wired up',
				};
			}
			// 清单按当前实际可用的工具算：计划模式、允许名单、插件开关都会改它，
			// 所以不能是注册期算一次的常量。它与宿主 `invokeTool` 判的是同一个集合
			// （`ctx.toolNames` 由循环从那张表直接取来）。
			const available = manifest(ctx.toolNames ?? []);
			const result = await runProgram({
				code,
				manifest: available,
				invoke: ctx.invokeTool,
				...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
			});
			return programToolResult(result);
		},
		prompt: PROMPT,
	};
}
