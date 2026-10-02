/**
 * 会话格式的版本与迁移。
 *
 * 这里钉三件事：
 *
 * 1. **写的文件自报版本**，且头部不被当成对话内容（列会话、预览、消息计数都不该看见它）。
 * 2. **没有头部即 v1**，且 v1 的文件照读——所有已存在的会话都是 v1，迁移写错就等于把
 *    用户的全部历史读坏。
 * 3. **迁移语义等价**：v1 的线性会话与「同一段内容但带 id」的会话，迁移后必须投影出
 *    完全相同的消息序列。这条是整条迁移唯一的正确性判据。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { JsonlSession, listSessions, parseSessionLine } from '@/plugins/sph-session/store.js';
import { loadTip, messagesOnPath } from '@/plugins/sph-session/tree.js';
import { asSessionHeader, IMPLICIT_VERSION, migrateRecords, SESSION_FORMAT_VERSION } from '@/session/format.js';
import type { SessionRecord } from '@/session/types.js';

function withTempDir<T>(fn: (dir: string) => T): T {
	const dir = mkdtempSync(join(tmpdir(), 'sph-format-'));
	try {
		return fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** 同上，给需要 await 的用例（`listSessions` 是异步的）。 */
async function withTempDirAsync<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), 'sph-format-'));
	try {
		return await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** 一段 v1 会话：没有头部、没有 id。 */
const V1_LINES = [
	'{"type":"message","ts":"2025-01-01T00:00:00.000Z","role":"user","content":"q1"}',
	'{"type":"message","ts":"2025-01-01T00:00:01.000Z","role":"assistant","content":"a1"}',
	'{"type":"message","ts":"2025-01-01T00:00:02.000Z","role":"user","content":"q2"}',
].join('\n');

describe('session format version', () => {
	it('writes a version header as the first line of a new session', () => {
		withTempDir((dir) => {
			const session = new JsonlSession(dir, 'ver');
			session.appendMessage({ role: 'user', content: 'hi' });

			const lines = readFileSync(join(dir, 'ver.jsonl'), 'utf8').split('\n').filter((l) => l !== '');
			const header = asSessionHeader(JSON.parse(lines[0]!));
			assert.ok(header, '第一行必须是头部');
			assert.equal(header.version, SESSION_FORMAT_VERSION);
			assert.equal(header.id, 'ver');
			assert.equal(lines[1] && JSON.parse(lines[1]).type, 'message', '头部之后才是内容');
		});
	});

	it('does not create a file until something is actually said', async () => {
		// 头部不能把「打开就建文件」这条约束改掉：空话题仍不该落盘。
		await withTempDirAsync(async (dir) => {
			new JsonlSession(dir, 'empty');
			assert.equal((await listSessions(dir)).length, 0, '没有消息的空会话不进列表');
		});
	});

	it('never exposes the header as conversation content', () => {
		withTempDir((dir) => {
			const session = new JsonlSession(dir, 'hidden');
			session.appendMessage({ role: 'user', content: 'only message' });

			const header = session.readAll().find((r) => (r as { type: string }).type === 'session');
			assert.equal(header, undefined, 'readAll 不该把头部当作记录交出去');

			const raw = readFileSync(join(dir, 'hidden.jsonl'), 'utf8').split('\n')[0]!;
			assert.equal(parseSessionLine(raw), undefined, '只认内容的解析器必须跳过头部');
		});
	});

	it('counts messages correctly for a session that has a header', async () => {
		// 列会话走的是流式扫描：头部若被当成内容，条数与预览都会错位。
		await withTempDirAsync(async (dir) => {
			const session = new JsonlSession(dir, 'counted');
			session.appendMessage({ role: 'user', content: 'first question' });
			session.appendMessage({ role: 'assistant', content: 'answer' });

			const list = await listSessions(dir);
			assert.equal(list.length, 1);
			assert.equal(list[0]!.messages, 2, '头部不参与计数');
			assert.equal(list[0]!.preview, 'first question', '预览取首条 user，不是头部');
		});
	});

	it('treats a file without a header as v1 and reads it', () => {
		withTempDir((dir) => {
			writeFileSync(join(dir, 'legacy.jsonl'), `${V1_LINES}\n`, 'utf8');
			const session = new JsonlSession(dir, 'legacy');
			assert.deepEqual(
				session.readMessages().map((m) => m.content),
				['q1', 'a1', 'q2'],
				'v1 会话必须原样读出来',
			);
		});
	});

	it('migrates v1 records to the current version, assigning tree ids', () => {
		const v1: SessionRecord[] = V1_LINES.split('\n').map((line) => JSON.parse(line) as SessionRecord);
		assert.equal(IMPLICIT_VERSION, 1);
		const migrated = migrateRecords(v1, IMPLICIT_VERSION);
		assert.ok(
			migrated.every((record) => typeof record.id === 'string' && record.id !== ''),
			'迁移后每条都要有 id，读点才不必再记得「无 id 是线性前缀」这条特例',
		);
		// 合成 id 不能撞上真实 id：真实 id 是 4 位十六进制。
		assert.ok(migrated.every((record) => record.id!.startsWith('legacy')));
	});

	it('is semantics-preserving: a migrated v1 session projects like an equivalent v2 one', () => {
		// 这是整条迁移唯一的正确性判据：内容相同的一段会话，带不带 id，读出来必须一样。
		withTempDir((dir) => {
			writeFileSync(join(dir, 'as-v1.jsonl'), `${V1_LINES}\n`, 'utf8');

			const v2 = new JsonlSession(dir, 'as-v2');
			v2.appendMessage({ role: 'user', content: 'q1' });
			v2.appendMessage({ role: 'assistant', content: 'a1' });
			v2.appendMessage({ role: 'user', content: 'q2' });

			const fromV1 = new JsonlSession(dir, 'as-v1');
			const v2Records = v2.readAll();
			const v1Records = fromV1.readAll();

			assert.deepEqual(
				messagesOnPath(v1Records, loadTip(v1Records)).map((m) => m.content),
				messagesOnPath(v2Records, loadTip(v2Records)).map((m) => m.content),
			);
		});
	});

	it('keeps reading a file whose version is newer than this build', () => {
		// 「新版写过、旧版打开」的情形：不猜、不拒绝，读得出来的照读。
		withTempDir((dir) => {
			const header = JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION + 1, id: 'future' });
			writeFileSync(join(dir, 'future.jsonl'), `${header}\n${V1_LINES.split('\n')[0]!}\n`, 'utf8');
			const session = new JsonlSession(dir, 'future');
			assert.deepEqual(session.readMessages().map((m) => m.content), ['q1']);
		});
	});

	it('appends a continuing session without rewriting the header', () => {
		withTempDir((dir) => {
			new JsonlSession(dir, 'append').appendMessage({ role: 'user', content: 'one' });
			// 重开（模拟重启）后继续追加：头部只该有一份。
			const reopened = new JsonlSession(dir, 'append');
			reopened.appendMessage({ role: 'user', content: 'two' });

			const raw = readFileSync(join(dir, 'append.jsonl'), 'utf8');
			const headers = raw.split('\n').filter((line) => line.includes('"type":"session"'));
			assert.equal(headers.length, 1, '重开后追加不该再写一个头部');
			assert.deepEqual(reopened.readMessages().map((m) => m.content), ['one', 'two']);
		});
	});
});
