import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Text } from '../components/primitives.js';
import { ScrollView } from '../components/scroll-view.js';
import { contentPaintRight, getScrollbarGeometry, getScrollViewBox, renderLayoutFrame } from './layout.js';

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
