/**
 * 测试地基：假 LLM、内存会话、一节脚本化的「一轮」，以及会话语料的录制与回放。
 *
 * 为什么要有它：循环、压缩、子代理这些语义只能靠「给定输入 → 观察行为」来钉住，而真实
 * 上游会让这件事同时失去三样东西——**确定性**（同一个提示两次跑出不同回复，失败时分不清
 * 是代码错了还是模型这次恰好不同）、**离线能力**（没 key 就一条用例都跑不了）、**成本与
 * 速度**（一轮几分钟、还花钱）。假 LLM 把这三样一次拿回来：回复是预先写好的，所以期望值
 * 可以写死。
 *
 * 与参考项目的差别：Pi 用 faux provider + test/suite/harness.ts，dsh 把录下来的真实会话当
 * 语料（snapshots/，无 key 整条重放）。这里两者都取一点，但形状照 sph 自己的接缝长：
 * `LlmClient` 只有一个方法，`SessionPort` 是接口，所以桩件加起来不到一百行，不需要框架。
 *
 * **脚本用完就重复最后一帧**：这条约定让「一直这样下去」的用例只写一帧（见
 * `unfinished-stream.test.ts` 的网关稳定掐断），而「这样一次然后那样」的用例按序写两帧。
 */

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent, AgentListener } from '@/agent/events.js';
import type { RunTurnOptions } from '@/agent/driver.js';
import type { LlmClient, StreamDelta } from '@/llm/client.js';
import type { SessionMessage, SessionPort, SessionRecord } from '@/session/types.js';
import { ToolRegistry } from '@/tools/registry.js';
import type { ToolSpec } from '@/tools/types.js';
import { runTurn } from '@/plugins/sph-loop/loop.js';

/** 一帧脚本回复。`arguments` 收对象也收字符串——线上形态是字符串，写用例时对象更顺手。 */
export interface ScriptedReply {
	text?: string;
	thinking?: string;
	finishReason?: string;
	toolCalls?: Array<{ id: string; name: string; arguments: unknown }>;
	usage?: StreamDelta['usage'];
}

/** 假 LLM 连同它的调用计数：用例几乎总要看「跑了几跳」。 */
export interface ScriptedClient {
	client: LlmClient;
	/** 已经发出的请求数（= 跳数）。 */
	calls: number;
	/** 每一跳收到的消息序列，供断言「落盘的东西真的进了下一轮提示」。 */
	seenMessages: SessionMessage[][];
}

/**
 * 假 LLM：每跳按脚本回一帧，脚本用完就重复最后一帧。
 *
 * 不模拟流式增量（`onDelta` 只在脚本给了 text/thinking 时回调一次），因为循环对增量的
 * 处置已经被 thinking/text 的节流用例覆盖；这里要钉的是**控制流**。
 */
export function scriptedClient(script: readonly ScriptedReply[]): ScriptedClient {
	assert.ok(script.length > 0, '脚本至少要有一帧，否则循环无内容可回');
	const state: ScriptedClient = {
		calls: 0,
		seenMessages: [],
		client: {
			async complete(messages, _tools, _signal, onDelta) {
				const reply = script[Math.min(state.calls, script.length - 1)] ?? {};
				state.calls += 1;
				state.seenMessages.push(messages as unknown as SessionMessage[]);
				if (reply.thinking) onDelta?.({ thinking: reply.thinking });
				if (reply.text) onDelta?.({ text: reply.text });
				return {
					text: reply.text ?? '',
					...(reply.thinking === undefined ? {} : { thinking: reply.thinking }),
					...(reply.finishReason === undefined ? {} : { finishReason: reply.finishReason }),
					...(reply.usage === undefined ? {} : { usage: reply.usage }),
					toolCalls: reply.toolCalls?.map((call) => ({
						id: call.id,
						name: call.name,
						arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments),
					})),
				};
			},
		},
	};
	return state;
}

/** 内存会话：记录落进数组而不是文件。`SessionPort` 是接口，这就是它存在的理由。 */
export interface MemorySession {
	session: SessionPort;
	/** 收到的全部记录，按写入顺序。 */
	records: SessionRecord[];
	/** 只要消息，省掉用例里的 filter。 */
	messages: SessionMessage[];
	/** 只要事件，断言 kind/data 用。 */
	events: Array<{ kind: string; data: Record<string, unknown> }>;
}

export function memorySession(id = 'test-session'): MemorySession {
	const memory: MemorySession = { records: [], messages: [], events: [], session: undefined as never };
	memory.session = {
		id,
		dir: '',
		append(record) {
			memory.records.push(record);
			if (record.type === 'message') memory.messages.push(record);
			else memory.events.push({ kind: record.kind, data: record.data });
		},
		appendMessage(message) {
			memory.records.push({ type: 'message', ts: new Date(0).toISOString(), ...message } as SessionRecord);
			memory.messages.push({ type: 'message', ts: new Date(0).toISOString(), ...message } as SessionMessage);
		},
		appendEvent(kind, data) {
			memory.records.push({ type: 'event', ts: new Date(0).toISOString(), kind, data } as SessionRecord);
			memory.events.push({ kind, data });
		},
		readAll: () => [...memory.records],
		readMessages: () => [...memory.messages],
	};
	return memory;
}

/** 一节脚本化「一轮」的结果。 */
export interface ScriptedTurn {
	client: ScriptedClient;
	saved: MemorySession;
	events: AgentEvent[];
	options: RunTurnOptions;
}

export interface RunScriptedTurnOptions {
	script: readonly ScriptedReply[];
	prompt?: string;
	workspaceRoot?: string;
	tools?: ToolSpec[];
	session?: MemorySession;
	/** 超时兜底。循环在某些路径上可以不收敛，用例必须变成失败断言而不是挂住测试进程。 */
	timeoutMs?: number;
	/** 覆盖或补充传给 `runTurn` 的字段。 */
	overrides?: Partial<RunTurnOptions>;
}

/**
 * 跑一节脚本化的回合。
 *
 * 默认值只给「能跑起来」的最小集：空工具表、空沙箱状态、一律批准的审批器、不收敛就超时。
 * 需要真实行为（工具、规则、子代理）的用例用 `overrides` 补——那是它们真正要测的东西。
 */
export async function runScriptedTurn(options: RunScriptedTurnOptions): Promise<ScriptedTurn> {
	const client = scriptedClient(options.script);
	const saved = options.session ?? memorySession();
	const events: AgentEvent[] = [];
	const listener: AgentListener = (event) => events.push(event);

	const runOptions: RunTurnOptions = {
		prompt: options.prompt ?? 'hi',
		workspaceRoot: options.workspaceRoot ?? process.cwd(),
		client: client.client,
		session: saved.session,
		tools: new ToolRegistry(options.tools ?? []),
		sandbox: { status: { mode: 'off' } } as never,
		// `Approver` 是对象（`decide` / 可选 `ask`），不是一个函数——写成函数会让
		// `approver.decide` 取到 undefined，而只有真的走到审批那一步才会暴露。
		approver: { decide: async () => true },
		contextWindow: 256000,
		// 循环要求会话工厂在场（子代理派生走它）。不派生子的用例给个占位。
		sessions: {
			create: () => saved.session,
			open: () => saved.session,
			resumeOrCreate: async () => saved.session,
		} as never,
		jobs: {
			startTask: () => '',
			onTaskDone: () => () => {},
			drainNotifications: () => [],
		} as never,
		memory: { noteTouch() {}, drain: () => [] },
		signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
		listener,
		...options.overrides,
	};

	await runTurn(runOptions);
	return { client, saved, events, options: runOptions };
}

// ---------------------------------------------------------------------------
// 会话语料：录制与回放
// ---------------------------------------------------------------------------

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sessions');

/** 语料里的一段原始行。回放要能看到坏行，所以按行收而不是按对象。 */
export interface SessionFixture {
	name: string;
	lines: string[];
}

export function fixturePath(name: string): string {
	return join(FIXTURE_ROOT, `${name}.jsonl`);
}

/**
 * 读一份语料的**原始行**。
 *
 * 不预先 parse：回放的意义在于「同一段字节，换一版代码，结果是否还一样」，所以坏行也要
 * 原样进到被测的解析路径里，而不是在读取层被过滤掉。
 */
export function readSessionFixture(name: string): SessionFixture {
	const text = readFileSync(fixturePath(name), 'utf8');
	return { name, lines: text.split('\n').filter((line) => line !== '') };
}

/**
 * 把一段会话写成语料。
 *
 * 录制与回放的入场券是同一种形状的字节——`sph export --format json` 的输出、`~/.sph/sessions`
 * 里的文件、以及这里写出来的语料，都是「一行一个 `SessionRecord`」。所以真实会话可以直接
 * 拷成语料，不需要转换器。
 */
export function writeSessionFixture(name: string, records: readonly SessionRecord[]): void {
	mkdirSync(FIXTURE_ROOT, { recursive: true });
	const body = records.map((record) => JSON.stringify(record)).join('\n');
	writeFileSync(fixturePath(name), `${body}\n`, 'utf8');
}

/** 语料目录，供用例自己列文件。 */
export function fixtureRoot(): string {
	return FIXTURE_ROOT;
}
