/**
 * 助手正文的流式节流：**过程可以滞后，收尾必须精确**。
 *
 * 正文每帧都在长，而重解析是 O(全文)（8K 字 6.6ms / 32K 字 64ms / 40K 字 ≈70ms，
 * 见 Markdown.setText）。不节流的话一份长回答边流边解析就是每帧几十到上百毫秒，
 * 实测 40K 字那档占空比 153%（帧率被拖死，按键像没反应）。节流后占空比 ≈44%。
 *
 * 两条不能破的契约：① 权威 setText 立即生效；② setStreaming(false) 那一帧给出全文
 * （正文只经 appendText 累加，收尾没有一次 setText 全文——所以它必须自己标脏）。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AssistantMessageComponent } from '@/plugins/sph-tui/messages/assistant-message.js';

const W = 80;
const body = (c: AssistantMessageComponent): string => c.render(W).join('\n');

describe('assistant body throttle', () => {
	it('applies an authoritative setText on the very same frame', () => {
		const c = new AssistantMessageComponent({});
		c.setStreaming(true);
		c.setText('a'.repeat(4096));
		c.render(W);
		// 连续两次权威 setText：第二次不能被节流窗口挡住。
		c.setText('a'.repeat(4096) + '\n\nAUTHORITATIVE');
		assert.ok(body(c).includes('AUTHORITATIVE'));
	});

	it('always shows the full text once the stream settles', () => {
		const c = new AssistantMessageComponent({});
		c.setStreaming(true);
		c.setText('a'.repeat(4096));
		c.render(W);
		// 跟着一串增量：中间帧允许滞后（可能被节流）。
		c.appendText('\n\nTHE-TAIL');
		// 收尾这一帧必须是全文——正文只经 appendText 累加，没有别的机会补上。
		c.setStreaming(false);
		assert.ok(body(c).includes('THE-TAIL'));
	});

	it('keeps the accumulated text while throttling (nothing is dropped)', () => {
		const c = new AssistantMessageComponent({});
		c.setStreaming(true);
		c.setText('head');
		c.appendText(' mid');
		c.appendText(' tail');
		c.setStreaming(false);
		const rendered = body(c);
		assert.ok(rendered.includes('head'));
		assert.ok(rendered.includes('mid'));
		assert.ok(rendered.includes('tail'));
	});
});
