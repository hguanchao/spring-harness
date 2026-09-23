import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { EMPTY_PLUGIN_SERVICES } from '../../src/plugins/types.js';
import type { ToolContext } from '../../src/tools/types.js';
import { searchReplaceTool } from '../../src/plugins/sph-tools/search-replace.js';

function ctx(root: string): ToolContext {
  return {
    workspaceRoot: root,
    sandboxMode: 'off',
    skills: [],
    todos: {} as ToolContext['todos'],
    jobs: {} as ToolContext['jobs'],
    services: EMPTY_PLUGIN_SERVICES,
    runShell: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    approve: async () => true,
    askUser: async () => '',
    noteMemoryTouch() {},
    spawnSubagent: async () => '',
    sendToSubagent: () => 'not_found',
  };
}

describe('search_replace newline and prefix', () => {
  it('CRLF file accepts LF old_string and keeps CRLF', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-sr-crlf-'));
    try {
      writeFileSync(join(root, 'a.ts'), 'export class Foo {\r\n  x = 1;\r\n}\r\n');
      const result = await searchReplaceTool.execute({
        path: 'a.ts',
        old_string: 'export class Foo {\n  x = 1;\n}',
        new_string: 'export class Foo implements Bar {\n  x = 1;\n}',
      }, ctx(root));
      assert.equal(result.ok, true);
      assert.equal(readFileSync(join(root, 'a.ts'), 'utf8'), 'export class Foo implements Bar {\r\n  x = 1;\r\n}\r\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('strips accidental read_file line prefixes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-sr-prefix-'));
    try {
      writeFileSync(join(root, 'a.ts'), 'export class Foo {\n  x = 1;\n}\n');
      const result = await searchReplaceTool.execute({
        path: 'a.ts',
        old_string: '  12|export class Foo {\n  13|  x = 1;\n  14|}',
        new_string: 'export class Foo implements Bar {\n  x = 1;\n}',
      }, ctx(root));
      assert.equal(result.ok, true);
      assert.match(readFileSync(join(root, 'a.ts'), 'utf8'), /implements Bar/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('not found names the path and asks for a re-read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-sr-miss-'));
    try {
      writeFileSync(join(root, 'a.ts'), 'hello\n');
      const result = await searchReplaceTool.execute({
        path: 'a.ts',
        old_string: 'missing',
        new_string: 'x',
      }, ctx(root));
      assert.equal(result.ok, false);
      assert.match(result.content, /old_string not found in a\.ts/);
      assert.match(result.content, /Re-read/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * new_string 会原样落盘，里面的 $ 序列不是替换模式。
   * 走字符串形式的 replaceAll 时 $& / $' / $` / $$ 会被展开，静默写坏文件内容。
   */
  it('replace_all 下 new_string 的 $ 序列按字面写入', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-sr-dollar-'));
    try {
      for (const [label, replacement] of [
        ['$&', 'x$&y'],
        ["$'", "x$'y"],
        ['$`', 'x$`y'],
        ['$$', 'x$$y'],
      ] as Array<[string, string]>) {
        writeFileSync(join(root, 'a.txt'), 'AAA bbb AAA\n');
        const result = await searchReplaceTool.execute({
          path: 'a.txt',
          old_string: 'bbb',
          new_string: replacement,
          replace_all: true,
        }, ctx(root));
        assert.equal(result.ok, true, label);
        assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), `AAA ${replacement} AAA\n`, label);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});