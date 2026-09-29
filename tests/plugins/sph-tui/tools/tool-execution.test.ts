import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TUI } from '@/tui/index.js';
import { visibleWidth } from '@/tui/index.js';
import { TOOL_DETAIL_INDENT, ToolExecutionComponent } from '@/plugins/sph-tui/tools/tool-execution.js';
import { theme } from '@/plugins/sph-tui/theme/theme.js';

const ui = {
  invalidateContent() {},
  requestRender() {},
  requestViewportRender() {},
} as unknown as TUI;

const STRIP = /\x1b\[[0-9;]*m/g;

/** 渲染出的可见行（去掉 ANSI 与竖轨缩进），第一行是工具行标题。 */
function rows(toolName: string, content: string, args: Record<string, unknown> = {}, width = 200): string[] {
  const tool = new ToolExecutionComponent(toolName, 'c1', args, ui);
  tool.markExecutionStarted();
  tool.updateResult({ content, isError: false });
  tool.setExpanded(true);
  return tool
    .render(width)
    .map((line) => line.replace(STRIP, '').replace(/\s+$/u, ''))
    .filter((line) => line.trim() !== '');
}

function body(toolName: string, content: string, args?: Record<string, unknown>, width = 200): string[] {
  return rows(toolName, content, args, width).slice(1);
}

/** read 工具的输出格式：首行工作区相对路径，正文每行 `padStart(4)|内容`。 */
function readOutput(rel: string, lines: readonly string[]): string {
  const numbered = lines.map((line, i) => `${String(i + 1).padStart(4, ' ')}|${line}`).join('\n');
  return `${rel}\n${numbered}`;
}

describe('工具详情折叠预览的窗口', () => {
  it('read 的路径首行不占窗口预算，头部从文件第 1 行开始', () => {
    const lines = ['# 标题', '', '## 章节', '', ...Array.from({ length: 12 }, (_, i) => `正文 ${i + 1}`), '', '尾 A', '尾 B'];
    const preview = body('read', readOutput('README.md', lines), { path: 'README.md' });
    assert.equal(preview.some((row) => row.includes('README.md')), false, '路径行不该出现在正文块里');
    assert.ok(preview.some((row) => row.includes('1|# 标题')), '头部应从文件第 1 行开始');
  });

  it('空行不占预算，头部能走到实质内容', () => {
    const lines = ['# 标题', '', '## 章节', '', ...Array.from({ length: 12 }, (_, i) => `正文 ${i + 1}`), '', '尾 A', '尾 B'];
    const preview = body('read', readOutput('README.md', lines), { path: 'README.md' });
    // 旧规则按输出行切窗口，头 5 行 = 标题/空行/章节/空行/正文 1，正文 3 根本露不出来。
    assert.ok(preview.some((row) => row.includes('正文 3')), `头部应走到正文 3，实际: ${preview.join(' | ')}`);
    assert.ok(preview.some((row) => row.includes('尾 B')), '尾部仍要有');
  });

  it('省略行数按内容行算，所有工具都写出来', () => {
    const lines = ['# 标题', '', '## 章节', '', ...Array.from({ length: 12 }, (_, i) => `正文 ${i + 1}`), '', '尾 A', '尾 B'];
    const preview = body('read', readOutput('README.md', lines), { path: 'README.md' });
    // 内容行 = 标题/章节/正文 1-12/尾 A/尾 B = 16 行，窗口 5 + 3，省略 8 行。
    assert.ok(preview.some((row) => row.includes('… (8 more)')), `省略行数应写出来，实际: ${preview.join(' | ')}`);
  });

  it('shell 的 exit/stdout 信封不占窗口，头部给真实输出', () => {
    const stdout = Array.from({ length: 12 }, (_, i) => `entry-${i + 1}`);
    const content = `exit 0\nstdout:\n${stdout.join('\n')}\nstderr:\nboom`;
    const preview = body('bash', content);
    assert.equal(preview.some((row) => row.includes('exit 0')), false, 'exit 码不是内容');
    assert.equal(preview.some((row) => row.includes('stdout:')), false, 'stdout 标记不是内容');
    assert.ok(preview.some((row) => row.includes('entry-1')), `头部应是真实输出，实际: ${preview.join(' | ')}`);
    assert.ok(preview.some((row) => row.includes('boom')), '尾部保留 stderr 正文');
    assert.ok(preview.some((row) => row.includes('stderr:')), 'stderr 标记要留着，否则看不出这段是错误输出');
  });

  it('stdout 为空时不留空壳，正文只剩 stderr', () => {
    const preview = body('bash', 'exit 1\nstdout: (empty)\nstderr:\nboom');
    assert.equal(preview.some((row) => row.includes('stdout')), false, '空 stdout 的标记不该占窗口');
    assert.ok(preview.some((row) => row.includes('boom')));
  });

  it('内容放得下时全给，不再补省略行', () => {
    const preview = body('read', readOutput('a.py', ['x = 1', '', 'y = 2']), { path: 'a.py' });
    assert.ok(preview.some((row) => row.includes('1|x = 1')));
    assert.ok(preview.some((row) => row.includes('3|y = 2')));
    assert.equal(preview.some((row) => row.includes('…')), false);
  });
});

describe('预览块的折行与省略符', () => {
  const width = 60;
  /** read 的行号列宽度：padStart(4) + `|`。 */
  const NUMBER_PREFIX = 5;

  /** 详情行里竖轨之后第一个非空字符的列。 */
  function inkColumn(row: string): number {
    const rail = row.indexOf('│');
    const rest = rail === -1 ? row : row.slice(rail + 1);
    return rail + 1 + (rest.length - rest.trimStart().length);
  }

  it('长行折行后，续行对齐到正文列（行号列右侧），不顶到竖轨上', () => {
    const long = 'xAI Grok Build 账号自动化工具：批量注册 → Device Flow 授权 → Token 交换 → 号池管理 → 推送。';
    const preview = body('read', readOutput('a.md', [long]), { path: 'a.md' }, width);
    const first = preview.find((row) => row.includes('1|'))!;
    const continuation = preview[preview.indexOf(first) + 1]!;
    assert.ok(continuation, `应有续行，实际: ${preview.join(' | ')}`);
    assert.equal(
      inkColumn(continuation),
      TOOL_DETAIL_INDENT + NUMBER_PREFIX,
      '续行要与正文同列，否则读起来像另一行内容',
    );
  });

  it('折行后每一行都不超过可用宽度，也不留只有竖轨的空行', () => {
    const long = `${'x'.repeat(140)} tail`;
    const preview = rows('read', readOutput('a.md', [long, '短行']), { path: 'a.md' }, width);
    for (const row of preview) {
      assert.ok(visibleWidth(row) <= width, `行超宽: ${JSON.stringify(row)}`);
      assert.ok(row.trim() !== '' && row.trim() !== '│', `出现只有竖轨的空行: ${JSON.stringify(row)}`);
    }
  });

  it('省略符与折行续行同一缩进，不自成一行', () => {
    const long = 'Grok Build 账号自动化工具：批量注册 Device Flow 授权 Token 交换 号池管理 推送。';
    const lines = [long, ...Array.from({ length: 14 }, (_, i) => `第 ${i + 2} 行`)];
    const preview = body('read', readOutput('a.md', lines), { path: 'a.md' }, width);
    const first = preview.find((row) => row.includes('1|'))!;
    const continuation = preview[preview.indexOf(first) + 1]!;
    const marker = preview.find((row) => row.includes('more)'))!;
    assert.ok(!continuation.includes('2|'), `第二行应是上面那句的续行，实际: ${continuation}`);
    assert.equal(inkColumn(continuation), TOOL_DETAIL_INDENT + NUMBER_PREFIX, '续行缩进');
    assert.equal(
      marker.indexOf('…'),
      inkColumn(continuation),
      `省略符要与续行同缩进（不居中），实际: ${JSON.stringify(marker)}`,
    );
  });

  it('没有行号的工具里，省略符也不额外缩进', () => {
    const stdout = Array.from({ length: 12 }, (_, i) => `entry-${i + 1}`);
    const preview = body('bash', `exit 0\nstdout:\n${stdout.join('\n')}`);
    const marker = preview.find((row) => row.includes('more)'))!;
    assert.equal(marker.indexOf('…'), TOOL_DETAIL_INDENT);
    assert.equal(inkColumn(preview.find((row) => row.includes('entry-1'))!), TOOL_DETAIL_INDENT);
  });
});

describe('展开后的工具行标题', () => {
  const colorsOf = (text: string): string[] => text.match(/\x1b\[38;(?:5;\d+|2;\d+;\d+;\d+)m/g) ?? [];

  it('双击展开后 Read 标题用正文色 #c6c6c6，收起后回到 muted', () => {
    const muted = colorsOf(theme.fg('muted', 'x'))[0];
    const text = colorsOf(theme.fg('text', 'x'))[0];
    const tool = new ToolExecutionComponent('glob', 'g1', { pattern: '*.ts' }, ui);
    tool.markExecutionStarted();
    tool.updateResult({ content: 'a.ts', isError: false });
    const folded = tool.render(80)[0] ?? '';
    assert.ok(colorsOf(folded).includes(muted), '收起时标题是 muted');
    assert.equal(colorsOf(folded).includes(text), false);
    tool.toggleDetail();
    const opened = tool.render(80)[0] ?? '';
    assert.ok(opened.includes(theme.fg('text', 'Glob')), '展开后只有 Glob 是 #c6c6c6');
    assert.ok(opened.includes(theme.fg('muted', ' *.ts')), '模式仍是 muted');
  });
});
