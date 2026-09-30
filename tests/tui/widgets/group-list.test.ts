import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FOLD_MARK, GroupList, type GroupListTheme, type GroupRow } from '@/tui/widgets/group-list.js';
import { visibleWidth } from '@/tui/text/utils.js';

/** 画笔只发 ANSI：引入可见字符会把列宽算错，测出来的对齐就是假的。 */
const theme: GroupListTheme = {
  selectedBg: (text) => `\x1b[41m${text}\x1b[49m`,
  hoverBg: (text) => `\x1b[45m${text}\x1b[49m`,
  fold: (text) => `\x1b[36m${text}\x1b[39m`,
};

const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');

function rows(): GroupRow[] {
  return [
    { key: 'user', kind: 'group', expanded: true, text: 'User — ~/.sph/skills' },
    { key: 'pdf', kind: 'item', indent: 1, text: 'pdf  Fill PDF forms' },
    { key: 'pdf-note', kind: 'note', indent: 2, text: 'SKILL.md', disabled: true },
    { key: 'project', kind: 'group', expanded: false, text: 'Project — /ws/.sph/skills' },
  ];
}

describe('GroupList', () => {
  it('分组头画折叠字形，其余行留同宽空槽让标签对齐', () => {
    const lines = new GroupList(rows(), theme).render(40);
    // 选中行铺底色时 pad 到整行宽（铺满由下面单独测），这里只看字形与缩进。
    assert.deepEqual(lines.map((line) => strip(line).trimEnd()), [
      `${FOLD_MARK.expanded} User — ~/.sph/skills`,
      '    pdf  Fill PDF forms',
      '      SKILL.md',
      `${FOLD_MARK.collapsed} Project — /ws/.sph/skills`,
    ]);
  });

  it('收起的分组画指右箭头，与转录里工具组的语汇一致', () => {
    assert.equal(FOLD_MARK.collapsed, '▸');
    assert.equal(FOLD_MARK.expanded, '▾');
  });

  it('选中行整行铺底色，宽度铺满可用宽度', () => {
    const lines = new GroupList(rows(), theme).render(40);
    assert.ok(lines[0]!.startsWith('\x1b[41m'), '默认选中第一行');
    assert.equal(visibleWidth(lines[0]!), 40, '底色要铺到整行，不是只包住文字');
    assert.ok(!lines[1]!.includes('\x1b[41m'));
  });

  it('尾列贴右端，且自己留一格间隙不粘右边', () => {
    const list = new GroupList(
      [{ key: 'r', kind: 'item', indent: 1, text: 'deny  Bash(rm -rf *)', trailing: 'project' }],
      theme,
    );
    // 选中行有整行底色 pad，去 掉 pad 后尾列应结束在倒数第二列。
    const line = strip(list.render(40)[0]!).trimEnd();
    assert.equal(line.endsWith('project'), true);
    assert.equal(visibleWidth(line), 39, '尾列结束在倒数第二列');
  });

  it('尾列放不下时整列舍弃，不把主文本挤成省略号', () => {
    const list = new GroupList(
      [{ key: 'r', kind: 'item', indent: 1, text: 'deny  Bash(rm -rf *)', trailing: '一个很长的来源名字' }],
      theme,
    );
    const line = strip(list.render(12)[0]!);
    assert.ok(!line.includes('来源'), '列宽不够时尾列整个让位');
  });

  it('主文本超宽时截断并带省略号', () => {
    const list = new GroupList([{ key: 'r', kind: 'item', text: 'x'.repeat(50) }], theme);
    const line = strip(list.render(10)[0]!);
    // 叶子条目前有 2 列折叠字形空槽，文本从第 2 列起。
    assert.equal(line, `  ${'x'.repeat(7)}…`);
    assert.equal(visibleWidth(line), 10);
  });

  it('不可选的行跳过导航：说明行不会成为高亮', () => {
    const list = new GroupList(rows(), theme);
    assert.equal(list.selectedRow()?.key, 'user');
    list.move(1, true);
    assert.equal(list.selectedRow()?.key, 'pdf', '越过不可选的说明行');
  });

  it('键盘回卷，滚轮到边界就停', () => {
    const list = new GroupList(rows(), theme);
    list.move(1, true);
    list.move(1, true);
    list.move(1, true);
    assert.equal(list.selectedRow()?.key, 'user', '到底再往下回卷到第一个可选行');
    const wheel = new GroupList(rows(), theme);
    wheel.move(-1, false);
    assert.equal(wheel.selectedRow()?.key, 'user', '滚轮不回卷，停在原处');
  });

  it('位置读数只数可选行，没溢出时为空', () => {
    const short = new GroupList(rows(), theme, 10);
    assert.equal(short.getScrollInfo(), '');
    const scrolled = new GroupList(rows(), theme, 2);
    assert.equal(scrolled.getScrollInfo(), '1/3', '四个行里三个可选');
  });

  it('换表之后选中项跟到同一个 key 上，而不是停在同一个序号', () => {
    const list = new GroupList(rows(), theme);
    list.setSelectedIndex(1);
    assert.equal(list.selectedRow()?.key, 'pdf');
    // 检索后只剩 Project 与其条目，pdf 不见了：夹到最近的可用行，不是停在 1 号。
    list.setRows([
      { key: 'project', kind: 'group', expanded: true, text: 'Project' },
      { key: 'sheet', kind: 'item', indent: 1, text: 'sheet' },
    ]);
    assert.equal(list.selectedRow()?.key, 'sheet');
  });

  it('换表之后原来那个 key 还在时，选中项跟着它走', () => {
    const list = new GroupList(rows(), theme);
    list.setSelectedIndex(3);
    list.setRows([
      { key: 'user', kind: 'group', expanded: true, text: 'User' },
      { key: 'project', kind: 'group', expanded: false, text: 'Project' },
    ]);
    assert.equal(list.selectedRow()?.key, 'project');
  });

  it('滚轮只改高亮，不回卷也不确认', () => {
    const list = new GroupList(rows(), theme);
    const result = list.handleMouse(wheel(1));
    assert.equal(result?.handled, true);
    assert.equal(list.selectedRow()?.key, 'pdf');
  });
});

/** 滚轮事件只带列表关心的字段，其余按无修饰补齐。 */
function wheel(delta: number): Parameters<GroupList['handleMouse']>[0] {
  return {
    type: 'wheel',
    button: 'none',
    x: 0,
    y: 0,
    screenX: 0,
    screenY: 0,
    width: 40,
    height: 10,
    shift: false,
    alt: false,
    ctrl: false,
    wheelDelta: delta,
  };
}
