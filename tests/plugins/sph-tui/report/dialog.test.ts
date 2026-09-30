import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ReportDialog } from '@/plugins/sph-tui/report/dialog.js';
import type { ReportTab } from '@/plugins/sph-tui/report/doc.js';
import { stripTerminalSequences } from '@/tui/text/utils.js';

/** 按键字面量集中在常量里：内联控制字符不可见，改起来是雷。 */
const ESC = '\x1b';
const DOWN = '\x1b[B';

/**
 * 测试用 tab：两个组（一个默认展开、一个默认收起）+ 一条 caption。
 * 不走注册表——这里测的是弹窗的键盘、渲染与降级行为，不是数据源。
 */
function fixture(): ReportTab {
  return {
    id: 'skills',
    label: 'Skills',
    empty: 'No skills match that.',
    blocks: [
      { kind: 'caption', text: 'Matched by name+description.' },
      {
        kind: 'group',
        group: {
          key: 'user',
          label: '#1 User — ~/.sph/skills',
          countNoun: 'skills',
          items: [
            { key: 'pdf', label: { text: 'pdf', tone: 'code', bold: true }, description: 'Fill PDF forms' },
            { key: 'sheet', label: { text: 'sheet', tone: 'code', bold: true }, description: 'Edit spreadsheets' },
          ],
        },
      },
      {
        kind: 'group',
        group: {
          key: 'proj',
          label: '#2 Project — /ws/.sph/skills',
          countNoun: 'skills',
          initiallyExpanded: false,
          items: [{ key: 'notes', label: { text: 'notes', tone: 'code', bold: true }, description: 'Take notes' }],
        },
      },
    ],
  };
}

const SPECS = [{ id: 'skills', label: 'Skills', build: () => fixture() }];

function dialog(budget = 24): ReportDialog {
  const instance = new ReportDialog(SPECS, 'skills', { workspaceRoot: '/ws' }, () => budget);
  return instance;
}

const strip = (line: string): string => stripTerminalSequences(line);
const visible = (lines: readonly string[]): string[] => lines.map(strip);

describe('ReportDialog', () => {
  it('单 tab：顶边嵌标题，框是直角，盒子吃满行预算', () => {
    const lines = dialog().render(80);
    assert.equal(lines.length, 24, '盒子吃满行预算');
    assert.ok(strip(lines[0]!).startsWith('┌─ Skills '), `顶边嵌标题，实际：${strip(lines[0]!)}`);
    assert.ok(strip(lines[0]!).endsWith('┐'));
    assert.ok(strip(lines[lines.length - 1]!).endsWith('┘'), '直角底边框');
  });

  it('正文按块顺序落位：caption 在组上方，搜索行在列表上方', () => {
    const lines = visible(dialog().render(80));
    const captionIndex = lines.findIndex((line) => line.includes('Matched by name+description.'));
    const searchIndex = lines.findIndex((line) => line.includes('/ to search'));
    const groupIndex = lines.findIndex((line) => line.includes('#1 User'));
    const pdfIndex = lines.findIndex((line) => line.includes('pdf'));
    assert.ok(searchIndex >= 0, '搜索行在场');
    assert.ok(captionIndex >= 0 && captionIndex < groupIndex, 'caption 先于组头');
    assert.ok(groupIndex < pdfIndex, '条目跟在组头后');
  });

  it('组头带折叠字形与计数后缀；默认收起的组不显示条目', () => {
    const lines = visible(dialog().render(80));
    const userLine = lines.find((line) => line.includes('#1 User'))!;
    const projLine = lines.find((line) => line.includes('#2 Project'))!;
    assert.ok(userLine.includes('▾'), '默认展开的组画下箭头');
    assert.ok(userLine.includes('(2 skills)'));
    assert.ok(projLine.includes('▸'), '默认收起的组画右箭头');
    assert.ok(lines.some((line) => line.includes('pdf')));
    assert.ok(!lines.some((line) => line.includes('notes')), '收起组的条目不渲染');
  });

  it('Enter 在组头上开合，条目上不做事', () => {
    const instance = dialog();
    instance.render(80);
    // 默认选中第一可选行（caption 不可选，落到 #1 User 组头）。Enter 收起它。
    instance.handleInput('\r');
    const closed = visible(instance.render(80));
    assert.ok(!closed.some((line) => line.includes('pdf')), '收起后条目消失');
    assert.ok(closed.find((line) => line.includes('#1 User'))!.includes('▸'));
    // 再 Enter 展开；移到条目上 Enter 则无事发生。
    instance.handleInput('\r');
    instance.handleInput(DOWN);
    instance.handleInput('\r');
    const reopened = visible(instance.render(80));
    assert.ok(reopened.some((line) => line.includes('pdf')), '组重新展开');
  });

  it('/ 进搜索、字符过滤、命中计数与命中数右侧对齐', () => {
    const instance = dialog();
    instance.render(80);
    instance.handleInput('/');
    instance.handleInput('p');
    instance.handleInput('d');
    instance.handleInput('f');
    const lines = visible(instance.render(80));
    const searchLine = lines.find((line) => line.includes('/ pdf'))!;
    assert.ok(searchLine.includes('1 hit'), '右侧报命中数');
    assert.ok(lines.some((line) => line.includes('pdf')), '命中条目在场');
    assert.ok(!lines.some((line) => line.includes('sheet')), '未命中条目退场');
    assert.ok(!lines.some((line) => line.includes('Matched by')), '检索时 caption 退场');
    assert.ok(lines.find((line) => line.includes('#1 User'))!.includes('(1/2 skills)'), '计数报命中/总数');
  });

  it('搜索零命中显示空态文案', () => {
    const instance = dialog();
    instance.render(80);
    instance.handleInput('/');
    instance.handleInput('z');
    instance.handleInput('z');
    instance.handleInput('z');
    const lines = visible(instance.render(80));
    assert.ok(lines.some((line) => line.includes('No skills match that.')));
    assert.ok(lines.some((line) => line.includes('0 hits')));
  });

  it('Esc 逐级退：清查询 → 退搜索 → 关弹窗', () => {
    const instance = dialog();
    let closed = 0;
    instance.onClose = () => (closed += 1);
    instance.render(80);
    instance.handleInput('/');
    instance.handleInput('p');
    instance.handleInput(`${ESC}[?1;2c`); // 终端响应串不该进查询
    instance.handleInput(ESC); // Esc 第一次：清查询（搜索态保留）
    const cleared = visible(instance.render(80));
    assert.ok(!cleared.some((line) => line.includes('/ p')), '查询被清掉');
    assert.ok(!cleared.some((line) => line.includes('to search')), '但仍在搜索态（占位提示没回来）');
    instance.handleInput(ESC); // Esc 第二次：退出搜索
    const exited = visible(instance.render(80));
    assert.ok(exited.some((line) => line.includes('/ to search')), '搜索行回到占位');
    instance.handleInput(ESC); // Esc 第三次：关闭
    assert.equal(closed, 1);
  });

  it('footer：窄终端按丢弃优先级收缩，Esc close 压轴', () => {
    const wide = visible(dialog().render(120)).find((line) => line.includes('close'))!;
    assert.ok(wide.includes('Enter fold'), '宽终端五项全在');
    assert.ok(wide.includes('Tab tab'));
    // 内宽 30 装不下五项：dropPriority 大的先丢（Tab tab 最先），Esc 留到最后。
    const narrow = visible(dialog().render(30)).find((line) => line.includes('close') || line.includes('Esc'))!;
    assert.ok(!narrow.includes('Tab tab'), 'Tab tab 先丢');
    assert.ok(narrow.includes('Esc close'), 'Esc 压轴');
  });

  it('滚轮移动高亮但不关弹窗', () => {
    const instance = dialog();
    instance.render(80);
    let closed = 0;
    instance.onClose = () => (closed += 1);
    const result = instance.handleMouse({
      type: 'wheel', button: 'none', x: 10, y: 10, screenX: 10, screenY: 10,
      width: 80, height: 24, shift: false, alt: false, ctrl: false, wheelDelta: 1,
    });
    assert.equal(result?.handled, true);
    assert.equal(closed, 0);
  });
});
