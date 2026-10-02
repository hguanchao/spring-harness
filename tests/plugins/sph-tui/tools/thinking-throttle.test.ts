/**
 * 思考正文的流式节流：**过程中的滞后可以，收尾必须精确**。
 *
 * 正文每帧都在长，而重解析是 O(全文)（见 Markdown.setText）。不节流的话一条长思考展开着
 * 就把帧率压到个位数——用户看到的是「滚不动、像卡死」。所以流式期间允许正文滞后几帧，
 * 但 `running=false` 那一次必须把权威全文落上去，否则尾巴会被吃掉。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolGroupComponent } from '@/plugins/sph-tui/tools/tool-group.js';

type ThinkingInternals = { expanded: boolean; running: boolean; text: string };

const makeGroup = (): { group: ToolGroupComponent; thinking: ThinkingInternals } => {
	const group = new ToolGroupComponent({ invalidateContent() {}, requestRender() {}, terminal: { columns: 100 } } as never);
	// 展开态从外部进不去（它只由双击切换），这里直接落到内部字段——测的是节流，不是手势。
	const members = (group as unknown as { members: { kind: string; thinking: ThinkingInternals }[] }).members;
	group.beginThinking();
	group.setThinking('', true);
	const thinking = members.find((m) => m.kind === 'thinking')!.thinking;
	thinking.expanded = true;
	group.render(100);
	return { group, thinking };
};

describe('streaming thinking body throttle', () => {
	it('always lands the authoritative text once the stream settles', () => {
		const { group } = makeGroup();
		// 连续增长：中间帧允许滞后（节流），但每帧都当新文本喂进去。
		for (let i = 1; i <= 40; i++) {
			group.setThinking('line\n'.repeat(i), true);
			group.render(100);
		}
		group.setThinking('line\n'.repeat(40) + 'THE-END', false, 1200);
		const rows = group.render(100).join('\n');
		assert.ok(rows.includes('THE-END'), '收尾帧必须给出全文结尾');
	});

	it('repaints the running row every frame even while the body is throttled', () => {
		// 节流只管正文：标题行的「Thinking…」/扫光必须每帧跟上，否则整行像卡住。
		const { group } = makeGroup();
		group.setThinking('body', true);
		const rows = group.render(100).join('\n');
		assert.match(rows, /Thinking/);
	});
});
