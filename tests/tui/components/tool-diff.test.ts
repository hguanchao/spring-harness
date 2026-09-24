import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TUI } from '../../../src/tui/index.js';
import { ToolExecutionComponent } from '../../../src/plugins/sph-tui/components/tool-execution.js';
import { ToolGroupComponent } from '../../../src/plugins/sph-tui/components/tool-group.js';
import { diffLines } from '../../../src/plugins/sph-tui/components/tool-diff.js';

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
