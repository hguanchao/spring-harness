import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ToolContext } from './types.js';
import { searchReplaceTool } from './search-replace.js';

function ctx(root: string): ToolContext {
  return {
    workspaceRoot: root,
    sandboxMode: 'off',
    skills: [],
    todos: {} as ToolContext['todos'],
    jobs: {} as ToolContext['jobs'],
    mcp: {} as ToolContext['mcp'],
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
});