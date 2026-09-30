import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { showConfirmDialog, showInputDialog, showMessageDialog, showSelectDialog } from '@/plugins/sph-tui/dialogs.js';
import { resolveOverlayWidth, type Component, type OverlayHandle, type OverlayOptions, type TUI } from '@/tui/index.js';

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

describe('对话框版式档位', () => {
	// 宽度上限按用途分档（终端 147 列时才生效）：确认框最窄、选择框中、文档框最宽。
	// 分档之前四类共用 84——两三项的确认框右侧一片空白，60+ 行的 /help 却要翻四屏。

	it('确认框取 confirm 档上限', () => {
		const { tui, overlays } = fakeTui(147, 40);
		void showConfirmDialog(tui, { title: 't', message: 'm' });
		assert.equal(overlays[0]?.maxWidth, 56);
		assert.equal(resolveOverlayWidth(overlays[0]?.width, 147, 147, undefined, overlays[0]?.maxWidth), 56);
	});

	it('选择框宽度随内容收，宽内容仍到 select 档上限', () => {
		const { tui, overlays } = fakeTui(147, 40);
		void showSelectDialog(tui, { title: 't', items: [{ value: 'a', label: 'a' }] });
		// 短菜单不再铺满档位：盒宽 = 最长内容 + 26 列余量（与标题取大）。
		assert.equal(overlays[0]?.maxWidth, 27);
		assert.equal(resolveOverlayWidth(overlays[0]?.width, 147, 147, undefined, overlays[0]?.maxWidth), 27);
		const wide = fakeTui(147, 40);
		void showSelectDialog(wide.tui, { title: 't', items: [{ value: 'a', label: 'x'.repeat(80) }] });
		// 80 + 26 = 106 超过档位上限——天花板仍是 84。
		assert.equal(wide.overlays[0]?.maxWidth, 84);
		assert.equal(resolveOverlayWidth(wide.overlays[0]?.width, 147, 147, undefined, wide.overlays[0]?.maxWidth), 84);
	});

	it('输入框宽度随内容收，长值仍到 input 档上限', () => {
		const { tui, overlays } = fakeTui(147, 40);
		void showInputDialog(tui, { title: 't' });
		// 无初始值的短输入收到 40 列地板，不再铺满 72。
		assert.equal(overlays[0]?.maxWidth, 40);
		assert.equal(resolveOverlayWidth(overlays[0]?.width, 147, 147, undefined, overlays[0]?.maxWidth), 40);
		const long = fakeTui(147, 40);
		void showInputDialog(long.tui, { title: 't', initialValue: 'v'.repeat(60) });
		// 60 + 24 = 84 超过档位上限——天花板仍是 72。
		assert.equal(long.overlays[0]?.maxWidth, 72);
		assert.equal(resolveOverlayWidth(long.overlays[0]?.width, 147, 147, undefined, long.overlays[0]?.maxWidth), 72);
	});

	it('文档框取 document 档上限', () => {
		const { tui, overlays } = fakeTui(147, 40);
		void showMessageDialog(tui, { title: 't', text: 'body' });
		assert.equal(overlays[0]?.maxWidth, 100);
		assert.equal(resolveOverlayWidth(overlays[0]?.width, 147, 147, undefined, overlays[0]?.maxWidth), 100);
	});

	it('调用方显式给宽度时仍然受本档上限约束', () => {
		const { tui, overlays } = fakeTui(147, 40);
		void showMessageDialog(tui, { title: 't', text: 'body', width: '100%' });
		assert.equal(resolveOverlayWidth(overlays[0]?.width, 147, 147, undefined, overlays[0]?.maxWidth), 100);
	});
});
