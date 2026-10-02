/**
 * 缓存经济学：把命中观测变成决策和钱。
 *
 * 观测层（`CacheMissTracker`）早就在了——它知道少命中了多少 token、是等太久还是换了模型。
 * 这里钉的是它下游那两件**用**它的事：
 *
 * 1. **决策**：一次性请求（压缩摘要）该不该打缓存断点。直觉是「缓存总是越多越好」，
 *    而算下来并不是：前缀已经不在缓存里时，断点等于按写入价（约 1.25 倍）买一份没人会读的
 *    缓存，不打反而只花 1.0 倍。
 * 2. **折钱**：未命中的浪费是 `input − cacheRead` 的**差额**，不是这些 token 的全价。
 *    报成全价会让人以为关掉缓存能省钱，而事实恰恰相反。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cacheMissCost, CacheMissTracker, CACHE_TTL_MS, oneOffCachePolicy } from '@/llm/cache-stats.js';
import { DEFAULT_REQUEST_CAPS } from '@/plugins/sph-llm/compat.js';
import { anthropicAdapter } from '@/plugins/sph-llm/anthropic.js';
import { callCaps } from '@/plugins/sph-llm/stream-client.js';
import type { ModelCostRates } from '@/llm/client.js';

const RATES: ModelCostRates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

describe('one-off cache policy', () => {
	const now = 1_000_000;

	it('avoids the write when there is no evidence the prefix is cached', () => {
		assert.equal(oneOffCachePolicy(undefined, now), 'avoid-write');
	});

	it('reuses the cache when the previous request hit it and is still fresh', () => {
		const previous = { promptTokens: 100_000, cachedTokens: 90_000, at: now - 30_000 };
		assert.equal(oneOffCachePolicy(previous, now), 'reuse');
	});

	it('avoids the write once the entry has outlived the TTL', () => {
		// 过期之后断点必然触发写入，而这次请求是一次性的：写进去没人读。
		const previous = { promptTokens: 100_000, cachedTokens: 90_000, at: now - CACHE_TTL_MS - 1 };
		assert.equal(oneOffCachePolicy(previous, now), 'avoid-write');
	});

	it('avoids the write when the previous request mostly missed', () => {
		// 命中率低说明前缀本来就不可复用（被驱逐或真的改了），断点只是白付写入价。
		const previous = { promptTokens: 100_000, cachedTokens: 1_000, at: now - 1_000 };
		assert.equal(oneOffCachePolicy(previous, now), 'avoid-write');
	});

	it('avoids the write when the endpoint does not report cache reads at all', () => {
		const previous = { promptTokens: 100_000, at: now - 1_000 };
		assert.equal(oneOffCachePolicy(previous, now), 'avoid-write');
	});

	it('is reachable through the tracker that produced the sample', () => {
		const tracker = new CacheMissTracker();
		assert.equal(tracker.oneOffCachePolicy(now), 'avoid-write', '还没跑过任何请求');
		tracker.observe({ promptTokens: 100_000, cachedTokens: 95_000, at: now - 1_000 });
		assert.equal(tracker.oneOffCachePolicy(now), 'reuse');
	});
});

describe('cache miss cost', () => {
	it('reports the premium paid, not the full price of the tokens', () => {
		// 100k token 本该按 0.3 读，实际按 3 计：多付的是差额。
		const cost = cacheMissCost(100_000, RATES);
		assert.ok(cost !== undefined);
		assert.equal(Number(cost.toFixed(6)), 0.27);
	});

	it('stays undefined when no price is declared', () => {
		// 「不知道价格」与「浪费了 $0」是两回事。
		assert.equal(cacheMissCost(100_000, undefined), undefined);
	});

	it('is zero when nothing was missed', () => {
		assert.equal(cacheMissCost(0, RATES), 0);
	});
});

describe('per-call cache switch', () => {
	it('turns off breakpoints for a one-off request', () => {
		const caps = callCaps(DEFAULT_REQUEST_CAPS, { cacheWrite: false });
		assert.equal(caps.promptCache, false);
	});

	it('leaves the session-level caps alone otherwise', () => {
		assert.equal(callCaps(DEFAULT_REQUEST_CAPS, undefined).promptCache, DEFAULT_REQUEST_CAPS.promptCache);
		assert.equal(callCaps(DEFAULT_REQUEST_CAPS, { cacheWrite: true }).promptCache, DEFAULT_REQUEST_CAPS.promptCache);
	});

	it('keeps the routing key even when writes are off', () => {
		// prompt_cache_key 是路由亲和，跟写不写缓存无关；关掉它只会让命中率更差。
		const caps = callCaps(DEFAULT_REQUEST_CAPS, { cacheWrite: false });
		assert.equal(caps.promptCacheKey, DEFAULT_REQUEST_CAPS.promptCacheKey);
	});
});

describe('anthropic request body', () => {
	const input = {
		model: 'test-model',
		messages: [
			{ role: 'user' as const, content: 'first question' },
			{ role: 'assistant' as const, content: 'first answer' },
			{ role: 'user' as const, content: 'the one-off directive' },
		],
		tools: [{ name: 'probe', description: 'x', input_schema: { type: 'object' } }],
	};

	it('places breakpoints by default', () => {
		const body = anthropicAdapter.buildBody(input, DEFAULT_REQUEST_CAPS);
		assert.ok(body.includes('cache_control'), '默认这一档必须真有断点，否则下一条断言是空转');
	});

	it('omits every breakpoint when the call opts out of cache writes', () => {
		// 这是端到端证据：纯函数判成 avoid-write 之后，请求体里真的一个断点都不剩。
		const body = anthropicAdapter.buildBody(input, callCaps(DEFAULT_REQUEST_CAPS, { cacheWrite: false }));
		assert.ok(!body.includes('cache_control'), '一次性请求不该按写入价买一份没人读的缓存');
	});
});
