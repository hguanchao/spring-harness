/**
 * 程序化工具调用（PTC）：模型写一段代码，代码里直接调工具，只有代码的输出回到上下文。
 *
 * ## 为什么值得单独做一层
 *
 * 现在的范式是「一个工具 = 一次往返」：模型在上下文里写一遍工具名和 JSON 参数、等结果、
 * 再决定下一步。三件事随工具数量增长而恶化：
 *
 * 1. **工具定义常驻上下文**。每个工具的名字、描述、JSON Schema 从头到尾占着位置，
 *    接几个 MCP server 就是几万 token，每请求付一遍。
 * 2. **每次调用是一次往返**。十次调用十轮请求。
 * 3. **中间结果全部留在上下文里**。grep 十个文件只看三个，十个结果永远留在历史里，
 *    还会被后续每次请求重新计费。
 *
 * PTC 把这三件一起改掉：十次 grep 在沙箱里循环，中间结果一个字节都不进上下文，只有
 * `text()` / `console.log()` 写出来的东西进。两家参考项目独立收敛到同一个形状
 * （pi 的 codemode 是 QuickJS-WASI，且是 MCP server 的默认暴露方式；dsh 的 run_code 是
 * 类型化绑定 + 沙箱 Node 进程），说明这不是口味问题。
 *
 * ## 边界，说清楚
 *
 * **沙箱不是安全边界。** 这一层给的是：模型代码跑在独立子进程里、只有一个 `vm` 上下文
 * 能看见（没有 `process`、没有 `require`、没有 `fs`）、只能通过 RPC 回调宿主来产生副作用。
 * 而宿主的每一次回调都走与模型直调**完全相同**的工具关卡（审批、规则、沙箱、钩子），
 * 见 `ToolContext.invokeTool`。所以真正的安全边界是工具关卡本身，不是 vm——与 sph 对
 * 自身沙箱的描述一致（同机文件策略，不是容器）。`vm` 在 Node 文档里也明确写着不是安全
 * 边界；把它放进子进程，是为了让逃逸的代价止于一个可以被 kill 的进程。
 *
 * **不做增量流式回传**：模型代码的输出一次性交回。这样结果形状与其它工具一致，
 * 循环的提交逻辑不必为它开分支。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mergeChildEnv } from '../sandbox/env.js';
import type { ToolResult } from './types.js';

/** 宿主侧执行一次内层工具调用。由循环经 `ctx.invokeTool` 接入，因此带全部关卡。 */
export type InvokeTool = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;

export interface RunProgramOptions {
	/** 模型写的代码：一个 async 函数体。 */
	code: string;
	/** 允许调用的工具名。子进程与宿主各判一次，两边都不放行清单外的名字。 */
	manifest: readonly string[];
	invoke: InvokeTool;
	/** 硬超时（毫秒）。到点 kill 子进程——`vm` 的 timeout 只约束同步执行，约束不了 await。 */
	timeoutMs?: number;
	/** 内层调用次数上限，防模型写出无上限的循环。 */
	maxCalls?: number;
	/** 交回模型的内容上限（字符）。 */
	maxOutputChars?: number;
	/** 取消信号：中止时 kill 子进程。 */
	signal?: AbortSignal;
}

export interface ProgramResult {
	/** 代码 `text()` / `console.log()` 出来的内容，已裁剪。 */
	output: string;
	/** 实际发生的内层工具调用次数。 */
	calls: number;
	/** 计时：从 spawn 到子进程退出。 */
	durationMs: number;
}

export interface ProgramFailure {
	/** 给人看的一句话失败原因。 */
	error: string;
	/** 失败前已经打印出来的内容，仍交回模型——半截输出常常已经说明了问题。 */
	output: string;
	calls: number;
	durationMs: number;
}

export const DEFAULT_PROGRAM_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_CALLS = 64;
export const DEFAULT_MAX_OUTPUT_CHARS = 32 * 1024;

/**
 * 子进程里的执行环境。
 *
 * 写成字符串而不是一个 `.js` 文件：它必须与父进程的版本同源，且不该出现在 `dist/` 里被
 * 当成一个可以单独运行的入口。代价是没有类型检查——所以它刻意保持短小，所有逻辑上值得
 * 单测的部分（协议编解码、限额、错误归类）都留在父进程这一侧。
 */
const HARNESS = String.raw`
import { createInterface } from 'node:readline';
import vm from 'node:vm';

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');

let run = undefined;
const pending = new Map();
let seq = 0;
let calls = 0;
const printed = [];

const flush = () => send({ type: 'done', output: printed.join('\n'), calls });

/** 把值渲染成一行给人看的文本：字符串原样，其余走 JSON。 */
const show = (value) => {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  try { return JSON.stringify(value, undefined, 2); } catch { return String(value); }
};
const emit = (value) => { printed.push(show(value)); };
const text = (...parts) => { printed.push(parts.map(show).join(' ')); };
const json = (value) => { printed.push(JSON.stringify(value, undefined, 2)); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

const callTool = (name, args) => {
  if (!run.manifest.includes(name)) {
    return Promise.reject(new Error('tool not exposed to run_code: ' + name));
  }
  if (calls >= run.maxCalls) {
    return Promise.reject(new Error('tool call limit reached (' + run.maxCalls + '); continue in a new run_code call'));
  }
  calls += 1;
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ type: 'call', id, tool: name, args: args === undefined ? {} : args });
  });
};

// 一律返回函数，清单判定交给 callTool：让 tools.gamma(...) 给出一句「这个工具没暴露」，
// 而不是 "tools.gamma is not a function"——后者会读成模型自己写错了 JS，把它引向错误的方向。
const tools = new Proxy({}, {
  get: (_target, name) => {
    if (typeof name !== 'string') return undefined;
    return (args) => callTool(name, args);
  },
});

const context = vm.createContext({
  tools,
  text,
  emit,
  json,
  sleep,
  console: { log: emit, info: emit, warn: emit, error: emit, debug: emit },
});

const finish = (message) => { send(message); process.exit(0); };

lines.on('line', async (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.type === 'result') {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.ok) entry.resolve(message.content);
    else entry.reject(new Error(message.content));
    return;
  }
  if (message.type !== 'run' || run !== undefined) return;
  run = message;
  try {
    const script = new vm.Script('(async () => {\n' + run.code + '\n})()', { filename: 'run_code.js' });
    const value = await script.runInContext(context);
    // 函数体的返回值也算输出：模型写 return 时不至于什么都没交回来。
    if (value !== undefined) emit(value);
    flush();
  } catch (error) {
    finish({ type: 'error', message: error && error.message ? error.message : String(error), output: printed.join('\n'), calls });
    return;
  }
  process.exit(0);
});
`;

/**
 * 跑一段模型写的代码，途中的工具调用回宿主执行。
 *
 * 三种失败各自可辨：**超时**（到点 kill）、**超调用上限**（子进程自己拒绝）、
 * **代码抛错**（交回错误原文与已打印的内容）。三者都带上已产生的输出，因为半截输出
 * 常常已经说明了问题，丢掉它等于让模型再猜一次。
 */
export async function runProgram(options: RunProgramOptions): Promise<ProgramResult | ProgramFailure> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_PROGRAM_TIMEOUT_MS;
	const maxCalls = options.maxCalls ?? DEFAULT_MAX_CALLS;
	const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
	const startedAt = Date.now();
	let calls = 0;

	const child: ChildProcessWithoutNullStreams = spawn(
		process.execPath,
		// 内存上限有意留宽：这是「别把宿主一起拖死」的兜底，不是配额。
		['--max-old-space-size=512', '--input-type=module', '-e', HARNESS],
		{
			stdio: ['pipe', 'pipe', 'pipe'],
			// 凭据不进子进程：同一套擦除规则，见 sandbox/env.ts。
			env: mergeChildEnv(),
		},
	);

	const elapsed = (): number => Date.now() - startedAt;
	let settled = false;

	return new Promise<ProgramResult | ProgramFailure>((resolve) => {
		let output = '';
		let stderr = '';

		const finishWith = (result: ProgramResult | ProgramFailure): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener('abort', onAbort);
			if (!child.killed) child.kill();
			resolve(result);
		};

		const fail = (error: string): void => finishWith({ error, output, calls, durationMs: elapsed() });

		const timer = setTimeout(() => {
			fail(`run_code timed out after ${timeoutMs}ms — narrow the script or split it into smaller runs`);
		}, timeoutMs);

		const onAbort = (): void => {
			fail('run_code aborted');
		};
		options.signal?.addEventListener('abort', onAbort, { once: true });

		child.stderr.on('data', (chunk: Buffer) => {
			// 子进程的 stderr 只当诊断：进程若异常退出，它就是唯一线索。
			if (stderr.length < 8_192) stderr += chunk.toString('utf8');
		});

		child.on('error', (error) => {
			fail(`run_code could not start a Node child process: ${error.message}`);
		});

		child.on('exit', (code, signal) => {
			if (settled) return;
			// 还没收到 done/error 就退了：异常退出。带上 code 与 stderr 的尾巴。
			const tail = stderr.trim() === '' ? '' : ` — ${stderr.trim().split('\n').slice(-3).join(' | ')}`;
			fail(`run_code child exited before finishing (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})${tail}`);
		});

		child.stdin.write(`${JSON.stringify({ type: 'run', code: options.code, manifest: options.manifest, maxCalls })}\n`);

		let buffer = '';
		child.stdout.on('data', (chunk: Buffer) => {
			buffer += chunk.toString('utf8');
			for (;;) {
				const newline = buffer.indexOf('\n');
				if (newline < 0) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line === '') continue;
				let message: Record<string, unknown>;
				try {
					message = JSON.parse(line) as Record<string, unknown>;
				} catch {
					continue;
				}
				void handleMessage(message);
			}
		});

		async function handleMessage(message: Record<string, unknown>): Promise<void> {
			switch (message.type) {
				case 'call': {
					const id = message.id;
					const tool = message.tool;
					if (typeof id !== 'number' || typeof tool !== 'string') return;
					// 名字在这里再判一次：子进程的代理已经挡过一道，但那是模型代码可以绕开
					// 的地方（它拿得到 tools 对象本身）。宿主这一道才是管的用的。
					if (!options.manifest.includes(tool)) {
						reply(id, { ok: false, content: `tool not exposed to run_code: ${tool}` });
						return;
					}
					calls += 1;
					const args = typeof message.args === 'object' && message.args !== null
						? (message.args as Record<string, unknown>)
						: {};
					try {
						reply(id, await options.invoke(tool, args));
					} catch (error) {
						reply(id, { ok: false, content: error instanceof Error ? error.message : String(error) });
					}
					return;
				}
				case 'done':
					output = typeof message.output === 'string' ? message.output : '';
					finishWith({
						output: clipProgramOutput(output, maxOutputChars),
						calls,
						durationMs: elapsed(),
					});
					return;
				case 'error':
					output = typeof message.output === 'string' ? message.output : '';
					finishWith({
						error: typeof message.message === 'string' ? message.message : 'the script failed',
						output: clipProgramOutput(output, maxOutputChars),
						calls,
						durationMs: elapsed(),
					});
					return;
				default:
					return;
			}
		}

		function reply(id: number, result: ToolResult): void {
			child.stdin.write(`${JSON.stringify({
				type: 'result',
				id,
				ok: result.ok,
				content: result.content,
				...(result.images === undefined ? {} : { images: result.images }),
				...(result.documents === undefined ? {} : { documents: result.documents }),
			})}\n`);
		}
	});
}

/**
 * 裁剪交回模型的输出。
 *
 * 头尾都留：代码的输出常常是「表头 + 一堆行 + 结论」，砍掉尾巴会丢掉结论那一行。
 */
export function clipProgramOutput(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const head = Math.floor(maxChars * 0.7);
	const tail = Math.max(0, maxChars - head);
	return `${text.slice(0, head)}\n...[truncated ${text.length - maxChars} chars in the middle]\n${text.slice(text.length - tail)}`;
}

/** 结果转成工具结果：失败也带上已打印的内容。 */
export function programToolResult(result: ProgramResult | ProgramFailure): ToolResult {
	if ('error' in result) {
		const printed = result.output.trim() === '' ? '' : `\n\nOutput before the failure:\n${result.output}`;
		return {
			ok: false,
			content: `${result.error} (after ${result.calls} tool call${result.calls === 1 ? '' : 's'})${printed}`,
		};
	}
	const header = result.calls === 0 ? '' : `[${result.calls} tool call${result.calls === 1 ? '' : 's'}]\n`;
	return { ok: true, content: result.output.trim() === '' ? `${header}(no output)`.trim() : `${header}${result.output}` };
}

/** 供工具描述引用：清单里不该出现的东西。 */
export function callableManifest(names: readonly string[]): string[] {
	return names.filter((name) => name !== 'run_code').sort();
}
