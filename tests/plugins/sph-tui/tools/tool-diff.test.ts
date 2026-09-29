import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TUI } from '@/tui/index.js';
import { ToolExecutionComponent } from '@/plugins/sph-tui/tools/tool-execution.js';
import { ToolGroupComponent } from '@/plugins/sph-tui/tools/tool-group.js';
import { diffLines } from '@/plugins/sph-tui/tools/tool-diff.js';

const ui = {
  invalidateContent() {},
  requestRender() {},
  requestViewportRender() {},
} as unknown as TUI;

const STRIP = /\x1b\[[0-9;]*m/g;

function plain(lines: string[]): string[] {
  return lines.map((line) => line.replace(STRIP, '').trimEnd()).filter((line) => line.trim() !== '');
}

describe('diffLines', () => {
  it('相同行留作上下文，改过的行分成删和增', () => {
    const diff = diffLines('const a = 1;\nconst b = 2;', 'const a = 1;\nconst b = 3;');
    assert.deepEqual(diff.lines.map((line) => `${line.kind}:${line.text}`), [
      'ctx:const a = 1;',
      'del:const b = 2;',
      'add:const b = 3;',
    ]);
    assert.equal(diff.added, 1);
    assert.equal(diff.removed, 1);
  });

  it('末尾换行不多出空行', () => {
    const diff = diffLines('a\n', 'b\n');
    assert.deepEqual(diff.lines.map((line) => line.text), ['a', 'b']);
  });
});

describe('工具行 diff', () => {
  it('组展开后成功的 edit 直接画出短 diff，并在行尾标增删', () => {
    const group = new ToolGroupComponent(ui);
    const tool = new ToolExecutionComponent('edit', 'e1', {
      path: 'a.ts',
      old_string: 'const a = 1;\nconst b = 2;',
      new_string: 'const a = 1;\nconst b = 3;',
      replace_all: true,
    }, ui);
    group.addTool(tool);
    tool.markExecutionStarted();
    tool.updateResult({ content: 'updated a.ts (2 replacements)', isError: false });
    assert.equal(plain(group.render(100)).some((row) => row.includes('const b')), false);
    group.setExpanded(true, false);

    const rows = plain(group.render(100));
    const title = rows.find((row) => row.includes('Edit a.ts'));
    assert.ok(title?.includes('+1'));
    assert.ok(title?.includes('-1'));
    assert.ok(title?.includes('all'));
    assert.ok(rows.some((row) => row.includes('- const b = 2;')));
    assert.ok(rows.some((row) => row.includes('+ const b = 3;')));
    assert.ok(rows.some((row) => row.includes('const a = 1;')));
    assert.equal(rows.some((row) => row.includes('updated a.ts')), false);
  });

  it('失败的 edit 只留错误原文', () => {
    const tool = new ToolExecutionComponent('edit', 'e2', {
      path: 'a.ts',
      old_string: 'old',
      new_string: 'new',
    }, ui);
    tool.setCompact(true);
    tool.markExecutionStarted();
    tool.updateResult({ content: 'old_string not found in a.ts', isError: true });
    tool.setExpanded(true);
    const rows = plain(tool.render(80));
    assert.ok(rows.some((row) => row.includes('old_string not found')));
    assert.equal(rows.some((row) => row.includes('+ new') || row.includes('- old')), false);
  });

  it('write 标明是写入内容，超过 8 行截断，双击后放到 80 行', () => {
    const content = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
    const tool = new ToolExecutionComponent('write', 'w1', { path: 'a.ts', content }, ui);
    tool.setCompact(true);
    tool.markExecutionStarted();
    tool.updateResult({ content: 'wrote a.ts (40 bytes)', isError: false });
    const preview = plain(tool.render(80));
    assert.ok(preview.some((row) => row.includes('written content')));
    assert.ok(preview.some((row) => row.includes('+ line 1')));
    assert.ok(preview.some((row) => row.includes('+ line 8')));
    assert.equal(preview.some((row) => row.includes('+ line 9')), false);
    assert.ok(preview.some((row) => row.includes('2 more')));
    assert.ok(preview.some((row) => row.includes('+10')));

    tool.toggleDetail();
    const expanded = plain(tool.render(80));
    assert.ok(expanded.some((row) => row.includes('+ line 10')));
    assert.equal(expanded.some((row) => row.includes('more')), false);
  });
});

/**
 * 展开详情的竖轨：详情块整块挂在 `│` 上，轨与成员行前缀（`▸`/`▾`，第 5 列）同列，
 * 内容仍从第 8 列起——和 Claude Code / Codex 的工具输出同款，详情一眼可知属于哪一行。
 */
describe('详情竖轨', () => {
  function expandedBashRows(width: number): string[] {
    const tool = new ToolExecutionComponent('bash', 'b1', { command: 'echo hi' }, ui);
    tool.setCompact(true);
    tool.markExecutionStarted();
    tool.updateResult({ content: 'hi', isError: false });
    tool.setExpanded(true);
    return tool.render(width).map((row) => row.replace(/\x1b\[[0-9;]*m/g, ''));
  }

  it('详情行行首是竖轨，轨后内容仍落在第 8 列', () => {
    const body = expandedBashRows(80).filter((row) => row.trim() !== '' && !row.includes('Bash'));
    assert.ok(body.length > 0, '展开后应有详情行');
    for (const row of body) {
      assert.ok(row.startsWith('     │'), `详情行应以 5 空格 + 竖轨开头，实际: ${JSON.stringify(row)}`);
      assert.match(row.slice(8), /\S/, '轨后的空格应把内容顶到第 8 列');
      assert.equal(row.slice(5, 8), '│  ');
    }
  });

  it('省略行（… N more）也在竖轨上，整块连贯', () => {
    const tool = new ToolExecutionComponent('bash', 'b2', { command: 'seq 20' }, ui);
    tool.setCompact(true);
    tool.markExecutionStarted();
    tool.updateResult({ content: Array.from({ length: 12 }, (_, i) => `out ${i + 1}`).join('\n'), isError: false });
    tool.setExpanded(true);
    const body = tool.render(80)
      .map((row) => row.replace(/\x1b\[[0-9;]*m/g, ''))
      .filter((row) => row.includes('more'));
    assert.ok(body.length > 0, '应有省略提示行');
    assert.ok(body.every((row) => row.startsWith('     │')), '省略行也要在竖轨上');
  });
});
