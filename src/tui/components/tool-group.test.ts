import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TUI } from '../core/index.js';
import { TOOL_GROUP_INDENT, TOOL_MEMBER_INDENT, ToolExecutionComponent } from './tool-execution.js';
import { ToolGroupComponent } from './tool-group.js';

let renderCount = 0;
let viewportCount = 0;
const ui = {
  requestRender: () => {
    renderCount++;
  },
  requestViewportRender: () => {
    viewportCount++;
  },
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
    ['第一轮：先看目录结构。', 'list_dir'],
    ['第二轮：读构建脚本。', 'read_file'],
    ['第三轮：跑一次编译。', 'shell'],
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
    assert.ok(rows[0]?.startsWith('● Listed'), `汇总行应在最前，实际: ${rows[0]}`);
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
    assert.ok(rows[0]?.startsWith('● Listed'));
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
    assert.equal(indentOfText('第一轮'), TOOL_MEMBER_INDENT + 2, '思考正文跟自己的行再缩 2');
    // 关键回归：思考正文不能和工具行同级，否则一段散文会读成工具列表的第一项。
    assert.notEqual(indentOfText('第一轮'), indentOfText('List a.java'));
  });

  it('折叠态进行中的思考也缩进，不和汇总行并排', () => {
    const group = new ToolGroupComponent(ui);
    const tool = new ToolExecutionComponent('list_dir', 'c1', { path: 'a.java' }, ui);
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

describe('ToolGroupComponent 思考段的独立展开', () => {
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
  it('running 增量仍走 requestRender：思考段在转录里，视口通道会命中滚动缓存', () => {
    renderCount = 0;
    viewportCount = 0;
    const group = new ToolGroupComponent(ui);
    group.beginThinking();
    renderCount = 0;
    viewportCount = 0;
    group.setThinking('逐步思考', true);
    assert.ok(renderCount >= 1, `流式思考应 bump 转录 generation，实际 requestRender=${renderCount}`);
    assert.equal(viewportCount, 0);
  });
});

describe('思考正文统一中性灰', () => {
  const colorsOf = (text: string): string[] => text.match(/\x1b\[38;(?:5;\d+|2;\d+;\d+;\d+)m/g) ?? [];

  it('详情里的标题/列表/序号/行内码全部压成 toolTitle 灰', async () => {
    // 思考内容是 markdown：全局主题会给列表序号上紫、行内码上蓝——
    // 推理记录是过程层，用户要求整体退成中性灰，一个彩字都不留。
    const { theme } = await import('../theme/theme.js');
    const gray = colorsOf(theme.fg('toolTitle', 'x'))[0];
    const group = new ToolGroupComponent(ui);
    group.beginThinking();
    group.setThinking('#### 注意\n- 项目 `x`\n1. 序号 `y`', false, 500);
    group.setExpanded(true, false);
    expandThinkings(group, [0]);
    const lines = group.render(100);
    const content = lines.filter((line) => /注意|项目|序号/.test(line.replace(STRIP, '')));
    assert.ok(content.length >= 3, '应有标题/列表/序号内容行');
    for (const line of content) {
      const colors = [...new Set(colorsOf(line))];
      assert.deepEqual(colors, [gray], '思考内容行应只有中性灰，实际: ' + colors.join(',') + ' — ' + line.replace(STRIP, ''));
    }
  });
});
