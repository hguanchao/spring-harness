import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TabBar, type TabBarTheme } from '@/tui/widgets/tab-bar.js';
import { visibleWidth } from '@/tui/text/utils.js';

/** 画笔只发 ANSI，不引入可见字符——否则会把列宽算错，测出来的折行位置就是假的。 */
const theme: TabBarTheme = {
  active: (text) => `\x1b[1m${text}\x1b[22m`,
  inactive: (text) => `\x1b[90m${text}\x1b[39m`,
};

const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');

function bar(labels: readonly string[]): TabBar {
  return new TabBar(labels, theme);
}

describe('TabBar', () => {
  it('单行渲染：标签之间留间隙，行宽不超可用宽度', () => {
    const lines = bar(['Skills', 'Plugins']).render(40);
    assert.equal(lines.length, 1);
    assert.equal(strip(lines[0]!), 'Skills   Plugins');
    assert.ok(visibleWidth(lines[0]!) <= 40);
  });

  it('选中态走加粗画笔，其余走弱化画笔', () => {
    const instance = bar(['Skills', 'Plugins']);
    instance.setActive(1);
    const line = instance.render(40)[0]!;
    assert.equal(line, '\x1b[90mSkills\x1b[39m   \x1b[1mPlugins\x1b[22m');
  });

  it('窄终端按标签边界折行，不在标签中间断', () => {
    const rows = bar(['Skills', 'Plugins', 'Permissions', 'Commands', 'Keys']).layout(30);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => row.map((slot) => slot.index)),
      [
        [0, 1, 2],
        [3, 4],
      ],
    );
    const lines = bar(['Skills', 'Plugins', 'Permissions', 'Commands', 'Keys']).render(30);
    assert.deepEqual(lines.map(strip), ['Skills   Plugins   Permissions', 'Commands   Keys']);
  });

  it('单条比整行还宽时整条舍弃：截断后的标签认不出是哪一栏', () => {
    const instance = bar(['A'.repeat(20)]);
    assert.deepEqual(instance.layout(10), []);
    assert.deepEqual(instance.render(10), []);
  });

  it('装不下的一条舍弃后，同一行的其余标签不受影响', () => {
    const rows = bar(['ab', 'A'.repeat(20)]).layout(10);
    assert.deepEqual(rows.map((row) => row.map((slot) => slot.index)), [[0]]);
  });

  it('切换在两端回卷', () => {
    const instance = bar(['a', 'b', 'c']);
    assert.equal(instance.active, 0);
    assert.equal(instance.prev(), 2);
    assert.equal(instance.next(), 0);
    assert.equal(instance.next(), 1);
  });

  it('越界的 setActive 被夹住，调用方不必自己判', () => {
    const instance = bar(['a', 'b']);
    instance.setActive(9);
    assert.equal(instance.active, 1);
    instance.setActive(-3);
    assert.equal(instance.active, 0);
  });

  it('命中判定按同一份折行布局：点在间隙或空白上不算命中', () => {
    const instance = bar(['Skills', 'Plugins']);
    assert.equal(instance.hitTest(40, 0, 0), 0);
    assert.equal(instance.hitTest(40, 0, 5), 0);
    assert.equal(instance.hitTest(40, 0, 6), undefined, '标签之间的间隙不是命中区');
    assert.equal(instance.hitTest(40, 0, 9), 1);
    assert.equal(instance.hitTest(40, 0, 30), undefined);
    assert.equal(instance.hitTest(40, 1, 0), undefined, '折行后没有第二行时，点空行不算命中');
  });

  it('折行后第二行的命中判定跟着那一行的布局走', () => {
    const instance = bar(['Skills', 'Plugins', 'Permissions', 'Commands', 'Keys']);
    assert.equal(instance.hitTest(30, 1, 0), 3, '第二行第 0 列是 Commands');
    assert.equal(instance.hitTest(30, 1, 11), 4, '第二行第 11 列是 Keys');
    assert.equal(instance.hitTest(30, 1, 8), undefined, '第二行第 8 列是间隙');
  });
});
