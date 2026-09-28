import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Text, VStack } from '../../../src/tui/primitives.js';
import { ScrollView } from '../../../src/tui/scroll-view.js';
import {
  allocateStackSizes,
  contentPaintRight,
  getScrollbarGeometry,
  getScrollViewBox,
  renderLayoutFrame,
} from '../../../src/tui/layout.js';
import { stripTerminalSequences } from '../../../src/tui/utils.js';

describe('allocateStackSizes', () => {
  const leaf = { component: { render: () => ['x'], invalidate() {} } };

  it('不给可用高度时按 intrinsic / basis', () => {
    const sizes = allocateStackSizes(
      [
        { ...leaf, basis: 3 },
        { ...leaf, basis: 'auto' },
      ],
      [9, 4],
      undefined,
      1,
    );
    assert.deepEqual(sizes, [3, 4]);
  });

  it('有剩余时按 grow 权重分配', () => {
    const sizes = allocateStackSizes(
      [
        { ...leaf, basis: 2, grow: 1 },
        { ...leaf, basis: 2, grow: 3 },
      ],
      [2, 2],
      12,
      0,
    );
    assert.equal(sizes[0]! + sizes[1]!, 12);
    assert.ok(sizes[1]! > sizes[0]!, 'grow 3 应分到更多');
  });

  it('超出时按 shrink 收，总和等于可用高度，不低于 minSize', () => {
    const sizes = allocateStackSizes(
      [
        { ...leaf, basis: 10, shrink: 1, minSize: 3 },
        { ...leaf, basis: 10, shrink: 1, minSize: 3 },
      ],
      [10, 10],
      8,
      0,
    );
    assert.equal(sizes[0]! + sizes[1]!, 8);
    assert.ok(sizes[0]! >= 3 && sizes[1]! >= 3);
  });

  it('gap 从可用高度里扣掉再分配', () => {
    const sizes = allocateStackSizes(
      [
        { ...leaf, basis: 2, grow: 1 },
        { ...leaf, basis: 2, grow: 1 },
      ],
      [2, 2],
      9,
      1,
    );
    assert.equal(sizes[0]! + sizes[1]!, 8);
  });
});

describe('ScrollView 布局缓存', () => {
  it('同代缓存命中后 follow-end 改了 scrollTop，文档仍跟着平移', () => {
    const body = Array.from({ length: 50 }, (_, i) => `L${i}`).join('\n');
    const view = new ScrollView(new Text(body, 0, 0), { follow: 'end', primary: true });
    const gen = 4;
    renderLayoutFrame(view, 20, 20, () => {}, gen);
    assert.equal(view.scrollTop, 30);

    // 视口变矮、内容世代不变：编辑器长高时转录被挤矮走这条路径。
    const frame = renderLayoutFrame(view, 20, 15, () => {}, gen);
    assert.equal(view.scrollTop, 35);
    const child = getScrollViewBox(frame, view)?.children[0];
    assert.equal(child?.rect.y, -35);
  });
});

describe('contentPaintRight', () => {
  it('有滚动条时右缘停在滑块列，不把内容装饰画上去', () => {
    const body = Array.from({ length: 40 }, (_, i) => `L${i}`).join('\n');
    const view = new ScrollView(new Text(body, 0, 0), { follow: 'end', primary: true, scrollbar: 'always' });
    const frame = renderLayoutFrame(view, 20, 10, () => {});
    const box = getScrollViewBox(frame, view);
    assert.ok(box);
    const geo = getScrollbarGeometry(box);
    assert.ok(geo);
    assert.equal(contentPaintRight(box), geo.column);
  });

  it('没有滚动条时右缘就是 clip 右缘', () => {
    const view = new ScrollView(new Text('short', 0, 0), { follow: 'end', primary: true, scrollbar: 'hidden' });
    const frame = renderLayoutFrame(view, 20, 10, () => {});
    const box = getScrollViewBox(frame, view);
    assert.ok(box);
    assert.equal(contentPaintRight(box), box.clip.x + box.clip.width);
  });
});

describe('auto 滚动条可见性', () => {
  it('第一次进入、内容装得下且没有可滚留白时不画滚动条', () => {
    const view = new ScrollView(new Text('Spring Harness', 0, 0), {
      follow: 'end',
      primary: true,
      scrollbar: 'auto',
    });
    const frame = renderLayoutFrame(view, 80, 24, () => {});
    const box = getScrollViewBox(frame, view);
    assert.ok(box);
    assert.equal(view.pinPad, 0);
    assert.equal(getScrollbarGeometry(box), undefined);
  });

  it('短对话也有滑块，贴在转录区底部，不铺满整列', () => {
    const body = Array.from({ length: 8 }, (_, i) => `L${i}`).join('\n');
    const view = new ScrollView(new Text(body, 0, 0), {
      follow: 'end',
      primary: true,
      scrollbar: 'auto',
    });
    view.setPinY(6);
    const frame = renderLayoutFrame(view, 20, 20, () => {});
    const box = getScrollViewBox(frame, view);
    assert.ok(box);
    assert.ok(view.pinPad > 0, '短内容仍可以钉住用户消息');
    const geo = getScrollbarGeometry(box);
    assert.ok(geo);
    assert.ok(geo.thumbHeight < geo.trackHeight, '短对话的滑块应是一小节');
    assert.equal(geo.thumbTop + geo.thumbHeight, geo.trackTop + geo.trackHeight);
  });

});

describe('scrollbarUntil', () => {
  it('follow-end 时滑块画到 until 组件顶，不停在转录区底', () => {
    const body = Array.from({ length: 40 }, (_, i) => `L${i}`).join('\n');
    const editor = new Text('prompt', 0, 0);
    const view = new ScrollView(new Text(body, 0, 0), {
      follow: 'end',
      primary: true,
      scrollbar: 'always',
    });
    const root = new VStack(
      [
        { component: view, basis: 0, grow: 1, shrink: 1, minSize: 1 },
        { component: editor, basis: 'auto', grow: 0, shrink: 0, minSize: 1 },
      ],
      { gap: 1 },
    );
    const frame = renderLayoutFrame(root, 20, 12, () => {});
    const scrollBox = getScrollViewBox(frame, view);
    assert.ok(scrollBox);
    const geo = getScrollbarGeometry(scrollBox);
    assert.ok(geo);
    const visit = (box: typeof frame.root): typeof frame.root | undefined => {
      if (box.component === editor) return box;
      for (const child of box.children) {
        const found = visit(child);
        if (found) return found;
      }
      return undefined;
    };
    const editorBox = visit(frame.root);
    assert.ok(editorBox);
    assert.ok(editorBox.rect.y > scrollBox.rect.y + scrollBox.rect.height);
    const gutter = editorBox.rect.y - 1;
    assert.equal(stripTerminalSequences(frame.lines[gutter] ?? '').includes('█'), false, '滑块不画出转录区');
    assert.ok(geo.thumbTop >= scrollBox.rect.y);
    assert.ok(geo.thumbTop + geo.thumbHeight <= scrollBox.rect.y + scrollBox.rect.height);
  });

  it('pin-reserve 吸顶时轨道仍铺满转录区，滑块同样接到 until', () => {
    const body = Array.from({ length: 16 }, (_, i) => `L${i}`).join('\n');
    const editor = new Text('prompt', 0, 0);
    const view = new ScrollView(new Text(body, 0, 0), {
      follow: 'end',
      primary: true,
      scrollbar: 'auto',
    });
    view.setPinY(12);
    const root = new VStack(
      [
        { component: view, basis: 0, grow: 1, shrink: 1, minSize: 1 },
        { component: editor, basis: 'auto', grow: 0, shrink: 0, minSize: 1 },
      ],
      { gap: 1 },
    );
    const frame = renderLayoutFrame(root, 20, 14, () => {});
    const scrollBox = getScrollViewBox(frame, view);
    assert.ok(scrollBox);
    assert.ok(view.pinPad > 0, '短回复应有 pin-reserve');
    const geo = getScrollbarGeometry(scrollBox);
    assert.ok(geo);
    assert.equal(geo.trackHeight, scrollBox.rect.height, '轨道高度等于转录视口');
    assert.ok(geo.thumbTop >= scrollBox.rect.y);
    assert.ok(geo.thumbTop + geo.thumbHeight <= scrollBox.rect.y + scrollBox.rect.height);
    const longBody = Array.from({ length: 40 }, (_, i) => `L${i}`).join('\n');
    const longView = new ScrollView(new Text(longBody, 0, 0), {
      follow: 'end',
      primary: true,
      scrollbar: 'auto',
    });
    longView.setPinY(30);
    const withPadFrame = renderLayoutFrame(longView, 20, 20, () => {});
    const withPadBox = getScrollViewBox(withPadFrame, longView);
    assert.ok(withPadBox);
    assert.ok(longView.pinPad > 0);
    const withPad = getScrollbarGeometry(withPadBox);
    longView.setPinY(undefined);
    const noPadFrame = renderLayoutFrame(longView, 20, 20, () => {});
    const noPadBox = getScrollViewBox(noPadFrame, longView);
    assert.ok(noPadBox && withPad);
    const noPad = getScrollbarGeometry(noPadBox);
    assert.ok(noPad);
    assert.ok(withPad.thumbHeight <= noPad.thumbHeight, '留白计入可滚高度时滑块应变短，而不是铺满');
    const visit = (box: typeof frame.root): typeof frame.root | undefined => {
      if (box.component === editor) return box;
      for (const child of box.children) {
        const found = visit(child);
        if (found) return found;
      }
      return undefined;
    };
    const editorBox = visit(frame.root);
    assert.ok(editorBox);
    const gutter = editorBox.rect.y - 1;
    assert.equal(stripTerminalSequences(frame.lines[gutter] ?? '').includes('█'), false, '滑块不画出转录区');
  });
});
