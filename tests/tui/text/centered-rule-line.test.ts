import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { centeredRuleLine, visibleWidth } from '@/tui/text/utils.js';

const plain = (text: string): string => text;

describe('centeredRuleLine', () => {
	it('draws a solid rule per side inside a block that is half the row, centered', () => {
		// 宽 120 → 块宽 60；「 Model set to X 」= 16 → 两侧各 22；整块缩进 (120−60)/2 = 30。
		assert.equal(
			centeredRuleLine('Model set to X', 120, plain),
			' '.repeat(30) + '─'.repeat(22) + ' Model set to X ' + '─'.repeat(22),
		);
	});

	it('gives the odd column to the right, both inside the block and in the row', () => {
		// 「 Model set to Xy 」= 17 → 块内余量 43 → 左 21 右 22。
		assert.equal(
			centeredRuleLine('Model set to Xy', 120, plain),
			' '.repeat(30) + '─'.repeat(21) + ' Model set to Xy ' + '─'.repeat(22),
		);
	});

	it('returns undefined rather than shortening the rules below the minimum', () => {
		// 文字 5 列 + 两侧各至少 4 根 = 13：宽度 12 时宁可让调用方退回折行。
		assert.equal(centeredRuleLine('abc', 12, plain), undefined);
		assert.equal(centeredRuleLine('abc', 13, plain), '──── abc ────');
	});

	it('measures display width, not string length', () => {
		// 「模型已切换」是 5 个汉字 = 10 列；按 length(5) 算会多画 5 根线、整块超宽。
		const line = centeredRuleLine('模型已切换', 72, plain) ?? '';
		const [left, right] = line.split(' 模型已切换 ');
		assert.equal((left ?? '').trim(), '─'.repeat(12));
		assert.equal(right, '─'.repeat(12));
	});

	it('hands the rule run to the caller to paint', () => {
		// 线是版式、文字是语气，两者上色各归各的——所以线只交出字符串，不在这里上色。
		assert.equal(centeredRuleLine('x', 11, (rule) => `[${rule}]`), '[────] x [────]');
	});

	it('never exceeds the row it was given', () => {
		for (const width of [13, 20, 41, 80, 120, 200]) {
			const line = centeredRuleLine('Model set to X', width, plain) ?? '';
			assert.ok(visibleWidth(line) <= width, `宽 ${width} 时溢出了`);
		}
	});
});
