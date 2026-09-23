import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { showInputDialog, showMessageDialog, showSelectDialog } from '../../src/plugins/sph-tui/dialogs.js';
import { resolveOverlayWidth, type Component, type OverlayHandle, type OverlayOptions, type TUI } from '../../src/plugins/sph-tui/screen/index.js';

const handle = {
	hide: () => {},
	setHidden: () => {},
	isHidden: () => false,
	focus: () => {},
	unfocus: () => {},
	isFocused: () => false,
} as unknown as OverlayHandle;

/** 只捕获 showOverlay 的选项；对话框内部渲染与本测试无关。 */
function fakeTui(columns: number, rows: number): { tui: TUI; overlays: OverlayOptions[] } {
	const overlays: OverlayOptions[] = [];
	const tui = {
		terminal: { columns, rows },
		showOverlay: (_component: Component, options?: OverlayOptions) => {
			overlays.push(options ?? {});
			return handle;
		},
	} as unknown as TUI;
	return { tui, overlays };
}

describe('resolveOverlayWidth', () => {
	it('百分比在宽终端上被上限夹住', () => {
		// 147 列 × 80% = 117，超过 88 就收到 88。
		assert.equal(resolveOverlayWidth('80%', 147, 147, undefined, 88), 88);
	});

	it('窄终端上百分比胜出，上限不参与', () => {
		// 60 列 × 80% = 48，比上限小，保持 48。
		assert.equal(resolveOverlayWidth('80%', 60, 60, undefined, 88), 48);
	});

	it('上限不越过可用宽度', () => {
		// 可用宽度只有 40 列时，88 的上限不该把弹窗撑出屏幕。
		assert.equal(resolveOverlayWidth('80%', 40, 40, undefined, 88), 32);
	});

	it('minWidth 与 maxWidth 同时给出时各自生效', () => {
		assert.equal(resolveOverlayWidth('10%', 200, 200, 40, 88), 40);
		assert.equal(resolveOverlayWidth('90%', 200, 200, 40, 88), 88);
	});

	it('未给宽度时沿用框架默认的 80 列', () => {
		assert.equal(resolveOverlayWidth(undefined, 200, 200), 80);
		assert.equal(resolveOverlayWidth(undefined, 40, 40), 40);
	});

	it('绝对宽度也被上限夹住', () => {
		assert.equal(resolveOverlayWidth(120, 200, 200, undefined, 96), 96);
	});
});

describe('对话框宽度上限', () => {
	it('选择框传上限', () => {
		const { tui, overlays } = fakeTui(147, 40);
		void showSelectDialog(tui, { title: 't', items: [{ value: 'a', label: 'a' }] });
		assert.equal(overlays[0]?.maxWidth, 88);
		assert.equal(resolveOverlayWidth(overlays[0]?.width, 147, 147, undefined, overlays[0]?.maxWidth), 88);
	});

	it('输入框传上限', () => {
		const { tui, overlays } = fakeTui(147, 40);
		void showInputDialog(tui, { title: 't' });
		assert.equal(overlays[0]?.maxWidth, 76);
		assert.equal(resolveOverlayWidth(overlays[0]?.width, 147, 147, undefined, overlays[0]?.maxWidth), 76);
	});

	it('消息框传上限', () => {
		const { tui, overlays } = fakeTui(147, 40);
		void showMessageDialog(tui, { title: 't', text: 'body' });
		assert.equal(overlays[0]?.maxWidth, 96);
		assert.equal(resolveOverlayWidth(overlays[0]?.width, 147, 147, undefined, overlays[0]?.maxWidth), 96);
	});

	it('调用方显式给宽度时仍然受上限约束', () => {
		const { tui, overlays } = fakeTui(147, 40);
		void showMessageDialog(tui, { title: 't', text: 'body', width: '100%' });
		assert.equal(resolveOverlayWidth(overlays[0]?.width, 147, 147, undefined, overlays[0]?.maxWidth), 96);
	});
});
