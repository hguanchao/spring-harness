/**
 * 双击识别的序列规则：第二下算双击，**第三下不算**（序列已清空）。
 *
 * 这条在列表/工具行上是可见行为：三连击若被读成「两次双击」，开合会被连翻两次、
 * 看着像没反应。四连击读作「单击 + 双击」。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DoubleClickTracker } from '@/tui/screen/double-click.js';

describe('double click tracker', () => {
	it('accepts the second click and rejects the third', () => {
		const tracker = new DoubleClickTracker();
		assert.equal(tracker.accept(0, 0), false);
		assert.equal(tracker.accept(0, 0), true);
		assert.equal(tracker.accept(0, 0), false, '第三下必须开新序列');
		assert.equal(tracker.accept(0, 0), true, '第四下才又配成一次双击');
	});

	it('does not pair clicks in different cells', () => {
		const tracker = new DoubleClickTracker(500, 2, 0);
		assert.equal(tracker.accept(0, 0), false);
		// slopY = 0：相邻行是两条不同项，各点一下不是双击。
		assert.equal(tracker.accept(0, 1), false);
	});
});
