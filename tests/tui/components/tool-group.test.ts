import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TUI, TuiMouseEvent } from '../../../src/tui/index.js';
import { visibleWidth } from '../../../src/tui/index.js';
import { TOOL_GROUP_INDENT, TOOL_MEMBER_INDENT, ToolExecutionComponent } from '../../../src/plugins/sph-tui/components/tool-execution.js';
import { ToolGroupComponent } from '../../../src/plugins/sph-tui/components/tool-group.js';
import { theme } from '../../../src/plugins/sph-tui/theme/theme.js';

let renderCount = 0;
let contentCount = 0;
const ui = {
  invalidateContent() {
    contentCount++;
  },
  requestRender: () => {
    renderCount++;
  },
  requestViewportRender() {},
} as unknown as TUI;
const STRIP = /\x1b\[[0-9;]*m/g;

function indentOf(line: string): number {
  const plain = line.replace(STRIP, '');
  return plain.length - plain.trimStart().length;
}

function rowsOf(group: ToolGroupComponent): string[] {
  return group
    .render(100)
    .map((line) => line.replace(STRIP, '').trim())
    .filter((text) => text !== '');
}

/** 思考段的展开态在 UI 里靠双击切换；布局测试直接置位。 */
function expandThinkings(group: ToolGroupComponent, indexes: readonly number[]): void {
  const members = (
    group as unknown as { members: Array<{ kind: string; thinking?: { expanded: boolean } }> }
  ).members;
  let seen = 0;
  for (const member of members) {
    if (member.kind !== 'thinking' || !member.thinking) continue;
    member.thinking.expanded = indexes.includes(seen++);
  }
}

/**
 * 模拟一次 run：三个迭代，每个迭代 = 一段思考 + 一个工具。
 * 组只在助手正文处断开，所以这三轮会并进同一个组。
 */
function buildThreeIterationGroup(): ToolGroupComponent {
  const group = new ToolGroupComponent(ui);
  let n = 0;
  const addTool = (name: string): void => {
    const tool = new ToolExecutionComponent(name, `c${++n}`, { path: 'a.java' }, ui);
    group.addTool(tool);
    tool.markExecutionStarted();
    tool.updateResult({ content: 'ok', isError: false });
  };
  const rounds: Array<[string, string]> = [
    ['第一轮：先看目录结构。', 'ls'],
    ['第二轮：读构建脚本。', 'read'],
    ['第三轮：跑一次编译。', 'bash'],
  ];
  for (const [thinking, tool] of rounds) {
    group.beginThinking();
    group.setThinking(thinking, false, 1000);
    addTool(tool);
  }
  return group;
}

describe('ToolGroupComponent 思考段的保留与交错', () => {
  it('同一组里多段思考互不覆盖', () => {
    const group = buildThreeIterationGroup();
    group.setExpanded(true, false);
    expandThinkings(group, [0, 1, 2]);
    const text = rowsOf(group).join('\n');
    for (const marker of ['第一轮', '第二轮', '第三轮']) {
      assert.ok(text.includes(marker), `${marker} 的思考正文丢了`);
    }
    // 旧实现只有一个 thinking 槽位，后一段会把前一段覆盖掉——这条就是那个回归点。
    assert.equal(rowsOf(group).filter((row) => row.includes('Thought for')).length, 3);
  });

  it('思考段与工具行按发生顺序交错，不堆在工具列表之前', () => {
    const group = buildThreeIterationGroup();
    group.setExpanded(true, false);
    const rows = rowsOf(group);
    assert.ok(rows[0]?.startsWith('▾ Listed'), `汇总行应在最前，实际: ${rows[0]}`);
    assert.deepEqual(
      rows.slice(1).map((row) => (row.includes('Thought for') ? 'T' : 'X')),
      ['T', 'X', 'T', 'X', 'T', 'X'],
      `每段思考应紧跟在自己的工具之前，实际: ${rows.slice(1).join(' | ')}`,
    );
  });

  it('组折叠时思考段随组收起，只剩汇总行', () => {
    const group = buildThreeIterationGroup();
    group.setExpanded(false, false);
    const rows = rowsOf(group);
    assert.equal(rows.length, 1, `折叠态只该有汇总行，实际: ${rows.join(' | ')}`);
    assert.ok(rows[0]?.startsWith('▸ Listed'));
  });
});

describe('ToolGroupComponent 缩进分层', () => {
  it('纯思考组（无工具）思考行在组级；有汇总行时思考行永远是成员级', () => {
    // 纯思考组：没有汇总行，思考行是唯一行——与其它组头同列。
    const solo = new ToolGroupComponent(ui);
    solo.beginThinking();
    solo.setThinking('纯思考段的内容', false, 1200);
    const soloLines = solo.render(100);
    const soloRow = soloLines.find((line) => line.replace(STRIP, '').includes('Thought for'));
    assert.ok(soloRow, '纯思考组应显示思考行');
    assert.equal(indentOf(soloRow), TOOL_GROUP_INDENT, '纯思考组的思考行在组级');

    // 带工具的组：思考行永远缩进一级，和汇总行并排会读成两件并列的事。
    const group = buildThreeIterationGroup();
    group.setExpanded(true, false);
    expandThinkings(group, [0]);
    const lines = group.render(100);
    const indentOfText = (needle: string): number => {
      const hit = lines.find((line) => line.replace(STRIP, '').includes(needle));
      assert.ok(hit !== undefined, `没找到含「${needle}」的行`);
      return indentOf(hit);
    };
    assert.equal(indentOfText('Listed'), TOOL_GROUP_INDENT, '汇总行在组级');
    assert.equal(indentOfText('Thought for'), TOOL_MEMBER_INDENT, '思考行与工具行同级');
    assert.equal(indentOfText('List a.java'), TOOL_MEMBER_INDENT, '工具行在成员级');
    assert.equal(
      indentOfText('第一轮'),
      TOOL_MEMBER_INDENT + visibleWidth('✲ '),
      '展开的思考正文和 Thought 文字持平，不跟 ✲ 对齐',
    );
    assert.ok(lines.some((line) => line.replace(STRIP, '').includes('✲ Thought for')), '思考标题带 ✲');
  });

  it('折叠态进行中的思考也缩进，不和汇总行并排', () => {
    const group = new ToolGroupComponent(ui);
    const tool = new ToolExecutionComponent('ls', 'c1', { path: 'a.java' }, ui);
    group.addTool(tool);
    tool.markExecutionStarted();
    group.beginThinking();
    group.setThinking('正在想下一步', true);
    group.setExpanded(false, false);
    const lines = group.render(100);
    const indentOfText = (needle: string): number => {
      const hit = lines.find((line) => line.replace(STRIP, '').includes(needle));
      assert.ok(hit !== undefined, `没找到含「${needle}」的行`);
      return indentOf(hit);
    };
    assert.equal(indentOfText('Listing'), TOOL_GROUP_INDENT, '汇总行在组级');
    assert.equal(indentOfText('Thinking'), TOOL_MEMBER_INDENT, '折叠态思考行仍是成员级');
    assert.ok(indentOfText('Thinking') > indentOfText('Listing'), '思考行应缩进到汇总行内部');
  });
});

function thinkingOf(group: ToolGroupComponent, index = 0): { expanded: boolean } {
  const members = (
    group as unknown as { members: Array<{ kind: string; thinking?: { expanded: boolean } }> }
  ).members;
  const thinkings = members.flatMap((member) =>
    member.kind === 'thinking' && member.thinking ? [member.thinking] : [],
  );
  const hit = thinkings[index];
  assert.ok(hit, `没有第 ${index} 段思考`);
  return hit;
}

function pointerGroup(group: ToolGroupComponent, type: 'click' | 'move', y: number, x = 10): void {
  const lines = group.render(100);
  const event: TuiMouseEvent = {
    type,
    button: type === 'move' ? 'none' : 'left',
    x,
    y,
    screenX: x,
    screenY: y,
    width: 100,
    height: lines.length,
    shift: false,
    alt: false,
    ctrl: false,
  };
  group.handleMouse(event);
}

function clickGroup(group: ToolGroupComponent, y: number, x = 10): void {
  pointerGroup(group, 'click', y, x);
}

function lineIndex(group: ToolGroupComponent, needle: string): number {
  const lines = group.render(100);
  const index = lines.findIndex((line) => line.replace(STRIP, '').includes(needle));
  assert.ok(index >= 0, `没找到含「${needle}」的行`);
  return index;
}

describe('ToolGroupComponent 思考段的独立展开', () => {
  it('双击详情正文也能收起，不必滚回 Thinking 标题', () => {
    const group = new ToolGroupComponent(ui);
    group.beginThinking();
    group.setThinking('第一轮：先看目录结构。\n第二段仍是详情。', false, 1000);
    expandThinkings(group, [0]);
    assert.equal(thinkingOf(group).expanded, true);
    assert.ok(rowsOf(group).some((row) => row.includes('第一轮')));

    const detailY = lineIndex(group, '第一轮');
    clickGroup(group, detailY);
    clickGroup(group, detailY);
    assert.equal(thinkingOf(group).expanded, false, '双击详情应收起');
    assert.ok(!rowsOf(group).some((row) => row.includes('第一轮')), '收起后详情不应再出现');
  });

  it('双击 Thinking 标题仍能展开', () => {
    const group = new ToolGroupComponent(ui);
    group.beginThinking();
    group.setThinking('第一轮：先看目录结构。', false, 1000);
    const titleY = lineIndex(group, 'Thought for');
    clickGroup(group, titleY);
    clickGroup(group, titleY);
    assert.equal(thinkingOf(group).expanded, true);
    assert.ok(rowsOf(group).some((row) => row.includes('第一轮')));
  });

  it('展开某一段不牵动其他段', () => {
    const group = buildThreeIterationGroup();
    group.setExpanded(true, false);
    expandThinkings(group, [0]);
    const text = rowsOf(group).join('\n');
    assert.ok(text.includes('第一轮'), '被展开的那段正文应可见');
    assert.ok(!text.includes('第二轮') && !text.includes('第三轮'), '其他段不该被带开');
  });

  it('折叠组不渲染任何思考正文', () => {
    const group = buildThreeIterationGroup();
    expandThinkings(group, [0, 1, 2]);
    group.setExpanded(false, false);
    const text = rowsOf(group).join('\n');
    assert.ok(!text.includes('第一轮') && !text.includes('第二轮') && !text.includes('第三轮'));
  });
});

describe('ToolGroupComponent 空思考链', () => {
  it('收尾时空思考不占行', () => {
    const group = new ToolGroupComponent(ui);
    group.beginThinking();
    group.setThinking('', false, 800);
    const rows = rowsOf(group);
    assert.equal(rows.length, 0);
    assert.ok(!rows.some((row) => row.includes('思考结束') || row.includes('Thinking')));
  });
});

describe('ToolGroupComponent 流式思考的绘制通道', () => {
  it('running 增量刷新转录内容，不走只重画视口的通道', () => {
    renderCount = 0;
    contentCount = 0;
    const group = new ToolGroupComponent(ui);
    group.beginThinking();
    renderCount = 0;
    contentCount = 0;
    group.setThinking('逐步思考', true);
    assert.ok(contentCount >= 1, `流式思考应刷新转录，实际 invalidateContent=${contentCount}`);
    assert.equal(renderCount, 0);
  });
});

describe('思考正文统一中性灰', () => {
  const colorsOf = (text: string): string[] => text.match(/\x1b\[38;(?:5;\d+|2;\d+;\d+;\d+)m/g) ?? [];

  it('详情里的标题/列表/序号/行内码全部压成 muted', async () => {
    // 思考内容是 markdown：全局主题会给列表序号上紫、行内码上蓝——
    // 推理记录是提示，整体退成 muted，一个彩字都不留。
    const { theme } = await import('../../../src/plugins/sph-tui/theme/theme.js');
    const gray = colorsOf(theme.fg('muted', 'x'))[0];
    const group = new ToolGroupComponent(ui);
    group.beginThinking();
    group.setThinking('#### 注意\n- 项目 `x`\n1. 序号 `y`', false, 500);
    group.setExpanded(true, false);
    expandThinkings(group, [0]);
    const lines = group.render(100);
    const content = lines.filter((line) => /注意|项目|序号/.test(line.replace(STRIP, '')));
    assert.ok(content.length >= 3, '应有标题/列表/序号内容行');
    const title = lines.find((line) => line.replace(STRIP, '').includes('Thought for'));
    assert.ok(title, '应有 Thought 标题');
    // 非 TTY / NO_COLOR 时 faint 不发码，强度断言只在发得出来的进程里做。
    if (theme.faint('x').includes('\x1b[2m')) {
      assert.equal(title.includes('\x1b[2m'), false, '标题不收细');
      assert.ok(content.every((line) => line.includes('\x1b[2m')), '详情用 faint 收细笔画');
    }
    for (const line of content) {
      const colors = [...new Set(colorsOf(line))];
      assert.deepEqual(colors, [gray], `思考内容行应只有 muted，实际: ${colors.join(',')} — ${line.replace(STRIP, '')}`);
    }
  });
});

describe('ToolGroupComponent 组收起复位下级', () => {
  it('组收起时复位成员详情，重新展开是干净的折叠列表', () => {
    const group = buildThreeIterationGroup();
    group.setExpanded(true, false);
    // 第一行的工具展开到预览（详情行出现）
    const tools = (
      group as unknown as { members: Array<{ kind: string; tool?: ToolExecutionComponent }> }
    ).members.filter((member) => member.kind === 'tool').map((member) => member.tool!);
    tools[0]!.toggleDetail();
    assert.ok(rowsOf(group).some((row) => row.includes('ok')), '展开后应能看到工具详情');

    group.setExpanded(false, false);
    group.setExpanded(true, false);
    const after = rowsOf(group);
    assert.equal(after.filter((row) => row.includes('ok')).length, 0, `重新展开后不应残留详情行，实际: ${after.join(' | ')}`);
    assert.equal(after.filter((row) => row.startsWith('▸')).length, 3, '完成的工具行用 ▸');
    assert.equal(after.filter((row) => row.includes('Thought for')).length, 3, '思考行不再带箭头');
    assert.equal(after.filter((row) => row.startsWith('▾') && !row.startsWith('▾ Listed')).length, 0, '未展开的成员不该是 ▾');
  });

  it('组收起时同样复位思考段详情', () => {
    const group = buildThreeIterationGroup();
    group.setExpanded(true, false);
    expandThinkings(group, [0, 1, 2]);
    assert.equal(rowsOf(group).filter((row) => row.includes('第一轮')).length, 1, '思考详情应已上屏');

    group.setExpanded(false, false);
    group.setExpanded(true, false);
    assert.equal(rowsOf(group).filter((row) => row.includes('第一轮')).length, 0, '重新展开后思考详情不应残留');
  });
});

describe('ToolGroupComponent 思考正文的交互', () => {
  it('展开正文紧贴标题行，中间没有空行', () => {
    const group = new ToolGroupComponent(ui);
    group.beginThinking();
    group.setThinking('第一轮：先看目录结构。', false, 1000);
    expandThinkings(group, [0]);
    const lines = group.render(100).map((line) => line.replace(STRIP, ''));
    const titleIndex = lines.findIndex((line) => line.includes('Thought for'));
    const bodyIndex = lines.findIndex((line) => line.includes('第一轮'));
    assert.ok(titleIndex >= 0, '应有思考标题行');
    assert.ok(bodyIndex > titleIndex, '正文应在标题之后');
    assert.deepEqual(lines.slice(titleIndex + 1, bodyIndex), [], '标题与正文之间不应有空行');
  });

  it('标题行按压钉行接管，正文行按压放行给全屏划词', () => {
    const group = new ToolGroupComponent(ui);
    group.beginThinking();
    group.setThinking('第一轮：先看目录结构。', false, 1000);
    expandThinkings(group, [0]);
    const lines = group.render(100);
    const titleY = lines.findIndex((line) => line.replace(STRIP, '').includes('Thought for'));
    const bodyY = lines.findIndex((line) => line.replace(STRIP, '').includes('第一轮'));
    assert.ok(titleY >= 0 && bodyY === titleY + 1, '正文应紧贴标题，正文按压才落在成员块 y≠0 处');

    const press = (y: number): { handled?: boolean } | undefined => {
      const event: TuiMouseEvent = {
        type: 'press',
        button: 'left',
        x: 10,
        y,
        screenX: 10,
        screenY: y,
        width: 100,
        height: lines.length,
        shift: false,
        alt: false,
        ctrl: false,
      };
      return group.handleMouse(event);
    };

    // 标题行（成员块局部 y=0）：接管——双击开合的触发面。
    assert.ok(press(titleY)?.handled, '标题行按压应被接管');
    // 正文行（y≠0）：放行——TUI 层按划词语义接手（全屏选词）。
    assert.equal(press(bodyY), undefined, '正文行按压应放行给划词');
  });
});

describe('工具行选中与悬停', () => {
  const hoverBg = theme.bgSeq('rowHoverBg');
  const selectedBg = theme.bgSeq('rowSelectedBg');

  it('单击汇总行留下选中底，再点思考行选中挪过去', () => {
    const group = buildThreeIterationGroup();
    group.setExpanded(true, false);
    const headerY = lineIndex(group, 'Listed');
    clickGroup(group, headerY);
    assert.ok(group.render(100)[headerY]?.includes(selectedBg), '汇总行应整行铺选中底');

    const thoughtY = lineIndex(group, 'Thought for');
    clickGroup(group, thoughtY);
    const lines = group.render(100);
    assert.equal(lines[headerY]?.includes(selectedBg), false, '选中应离开汇总行');
    assert.ok(lines[thoughtY]?.includes(selectedBg), '思考行应整行铺选中底');
  });

  it('悬停只铺当前标题，不抢走已选中的另一行', () => {
    const group = buildThreeIterationGroup();
    group.setExpanded(true, false);
    const headerY = lineIndex(group, 'Listed');
    clickGroup(group, headerY);
    const thoughtY = lineIndex(group, 'Thought for');
    pointerGroup(group, 'move', thoughtY);
    const lines = group.render(100);
    assert.ok(lines[headerY]?.includes(selectedBg), '悬停不应清掉汇总行的选中');
    assert.ok(lines[thoughtY]?.includes(hoverBg), '思考标题应铺悬停底');
    assert.equal(lines[thoughtY]?.includes(selectedBg), false, '悬停不是选中');
  });

  it('工具详情上的移动不给标题铺底，标题上的移动才铺', () => {
    const tool = new ToolExecutionComponent('read', 'c-hover', { path: 'a.java' }, ui);
    tool.markExecutionStarted();
    tool.updateResult({ content: 'ok', isError: false });
    tool.setExpanded(true);
    const move = (y: number): void => {
      tool.render(80);
      tool.handleMouse({
        type: 'move',
        button: 'none',
        x: 4,
        y,
        screenX: 4,
        screenY: y,
        width: 80,
        height: 8,
        shift: false,
        alt: false,
        ctrl: false,
      });
    };
    move(1);
    assert.equal(tool.render(80)[0]?.includes(hoverBg), false, '详情行不应点亮标题');
    move(0);
    assert.ok(tool.render(80)[0]?.includes(hoverBg), '标题行悬停应整行铺底');
    tool.render(80);
    tool.handleMouse({
      type: 'click',
      button: 'left',
      x: 4,
      y: 0,
      screenX: 4,
      screenY: 0,
      width: 80,
      height: 8,
      shift: false,
      alt: false,
      ctrl: false,
    });
    assert.ok(tool.render(80)[0]?.includes(selectedBg), '单击工具行应留下选中底');
  });
});
