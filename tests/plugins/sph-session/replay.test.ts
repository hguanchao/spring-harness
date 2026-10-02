/**
 * 会话语料回放：同一段字节，换一版代码，结果是否还一样。
 *
 * 语料分两类，理由不同：
 *
 * 1. **冻结在盘的病态形状**（`tests/fixtures/sessions/*.jsonl`）。旧版写的会话、被外部工具
 *    改坏的行——现在的写入器**再也产生不出这些字节**，所以它们只能冻在盘上。这是语料库真正
 *    不可替代的部分：能重新生成的输入不需要语料，重新生成不出来的才需要。
 * 2. **录制后回放**（本文件里的写—读往返）。当前形状由真实 `JsonlSession` 写出来再回放，
 *    所以语料永远跟着实现走，不会陈旧；它抓的是「格式改了但读法没跟上」。
 *
 * 断言钉的都是**意图**（哪条留、哪条被摘掉、摘要是否取代了被覆盖的部分），不是当前实现的
 * 输出快照——快照会因为无关重构而红，那就失去作为回归网的价值。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { JsonlSession, parseSessionLine } from '@/plugins/sph-session/store.js';
import { lineage, loadTip, messagesOnPath } from '@/plugins/sph-session/tree.js';
import { wireFromMessages } from '@/plugins/sph-loop/compact.js';
import type { SessionRecord } from '@/session/types.js';
import { fixturePath } from '../../harness.js';

/** 按真实解析路径读一份冻结语料：坏行在解析层被跳过，而不是在读取层被预过滤。 */
function replay(name: string): SessionRecord[] {
	const text = readFileSync(fixturePath(name), 'utf8');
	const records: SessionRecord[] = [];
	for (const line of text.split('\n')) {
		const record = parseSessionLine(line);
		if (record) records.push(record);
	}
	return records;
}

function withTempDir<T>(fn: (dir: string) => T): T {
	const dir = mkdtempSync(join(tmpdir(), 'sph-replay-'));
	try {
		return fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe('session corpus replay', () => {
	it('keeps every record of a v1 linear session that has no ids at all', () => {
		// v1 的记录没有 id/parentId。树形读法不能因为「找不到 id」就丢掉它们——
		// 那等于让升级把历史会话清空。
		const records = replay('linear-legacy');
		assert.equal(records.length, 3, '三行都必须读出来');
		const path = lineage(records, loadTip(records));
		assert.equal(path.length, 3, '无 id 的记录视为线性前缀，永远保留');
		const messages = messagesOnPath(records, loadTip(records));
		assert.deepEqual(messages.map((m) => m.content), ['legacy question', 'legacy answer']);
	});

	it('skips a damaged line and keeps reading the rest of the file', () => {
		// 会话是可追加日志：半个 JSON、被改坏的行、不认识的 type，都不该让后续历史变得不可读。
		const records = replay('damaged');
		assert.equal(records.length, 3, '坏行跳过，其余三行照读');
		const messages = messagesOnPath(records, loadTip(records));
		assert.deepEqual(messages.map((m) => m.content), ['first', 'second', 'third']);
	});

	it('round-trips a session written by the real writer', () => {
		withTempDir((dir) => {
			const written = new JsonlSession(dir, 'roundtrip');
			written.appendMessage({ role: 'user', content: 'hello' });
			written.appendMessage({ role: 'assistant', content: 'hi there' });

			const result = new JsonlSession(dir, 'roundtrip').readAll();
			const messages = messagesOnPath(result, loadTip(result));
			assert.deepEqual(messages.map((m) => m.content), ['hello', 'hi there']);
		});
	});

	it('follows only the live branch and excludes the abandoned one', () => {
		withTempDir((dir) => {
			const session = new JsonlSession(dir, 'branched');
			session.append({ type: 'message', ts: '2026-01-01T00:00:00.000Z', role: 'user', content: 'q', id: 'a1', parentId: null });
			session.append({ type: 'message', ts: '2026-01-01T00:00:01.000Z', role: 'assistant', content: 'a', id: 'a2', parentId: 'a1' });
			// 走上一条岔路，再退回来走另一条。
			session.append({ type: 'message', ts: '2026-01-01T00:00:02.000Z', role: 'user', content: 'abandoned', id: 'a3', parentId: 'a2' });
			session.setTip('a2');
			session.append({ type: 'message', ts: '2026-01-01T00:00:03.000Z', role: 'user', content: 'kept', id: 'b3', parentId: 'a2' });

			const result = new JsonlSession(dir, 'branched').readAll();
			const messages = messagesOnPath(result, loadTip(result));
			assert.deepEqual(
				messages.map((m) => m.content),
				['q', 'a', 'kept'],
				'弃枝仍在文件里，但不该出现在当前分支上',
			);
			assert.ok(
				result.some((r) => r.type === 'message' && r.content === 'abandoned'),
				'弃枝必须还在文件里——回放是读法，不是清理',
			);
		});
	});

	it('replaces the covered span with the summary and keeps later messages', () => {
		withTempDir((dir) => {
			const session = new JsonlSession(dir, 'compacted');
			session.appendMessage({ role: 'user', content: 'buried question' });
			session.appendMessage({ role: 'assistant', content: 'buried answer' });
			session.appendMessage({ role: 'user', content: 'recent question' });
			session.appendEvent('compaction', { summary: 'THE-SUMMARY', covered: 2 });

			const result = new JsonlSession(dir, 'compacted').readAll();
			const projected = wireFromMessages(messagesOnPath(result, loadTip(result)), { summary: 'THE-SUMMARY', covered: 2 });
			const text = projected.messages.map((m) => m.content).join('\n');
			assert.ok(text.includes('THE-SUMMARY'), '摘要必须出现在投影里');
			assert.ok(text.includes('recent question'), '被覆盖范围之后的消息必须留下');
			assert.ok(!text.includes('buried question'), '被覆盖的消息不该再进上下文');
			assert.ok(!text.includes('buried answer'), '被覆盖的消息不该再进上下文');
		});
	});

	it('resolves the same tip after reopening as the writer held in memory', () => {
		// 重开文件必须复现关机前的分支头。读法一旦与 append 的内存规则分叉，恢复会话
		// 就会悄悄少掉最后几轮——而用户看到的是「我的对话不见了」，不是一条报错。
		withTempDir((dir) => {
			const session = new JsonlSession(dir, 'tip-reload');
			session.append({ type: 'message', ts: '2026-01-01T00:00:00.000Z', role: 'user', content: 'first', id: 'a1', parentId: null });
			session.append({ type: 'message', ts: '2026-01-01T00:00:01.000Z', role: 'assistant', content: 'reply', id: 'a2', parentId: 'a1' });
			// 回到 a1 再往前接一条：tip 应当是这条新的，而不是 setTip 的目标。
			session.setTip('a1');
			session.append({ type: 'message', ts: '2026-01-01T00:00:02.000Z', role: 'user', content: 'second', id: 'b2', parentId: 'a1' });

			const inMemoryTip = session.tip;
			const reloaded = new JsonlSession(dir, 'tip-reload');
			assert.equal(reloaded.tip, inMemoryTip, '重开后的 tip 必须与关机前一致');
			assert.deepEqual(
				messagesOnPath(reloaded.readAll(), reloaded.tip).map((m) => m.content),
				['first', 'second'],
				'分支切换后追加的消息必须仍在当前分支上',
			);
		});
	});
});
