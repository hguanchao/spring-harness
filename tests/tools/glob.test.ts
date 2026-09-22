import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { GLOB_MAX_RESULTS, globToRegExp, globTool, matchGlob } from '../../src/tools/glob.js';
import { EMPTY_PLUGIN_SERVICES } from '../../src/plugins/types.js';
import type { ToolContext } from '../../src/tools/types.js';

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

describe('matchGlob', () => {
  it('matches a basename pattern at any depth', () => {
    assert.equal(matchGlob('a.ts', '*.ts'), true);
    assert.equal(matchGlob('src/foo.ts', '*.ts'), true);
    assert.equal(matchGlob('src/nested/foo.ts', '*.ts'), true);
    assert.equal(matchGlob('src/foo.js', '*.ts'), false);
  });

  it('treats * as a single path segment when the pattern has a slash', () => {
    assert.equal(matchGlob('src/a.ts', 'src/*.ts'), true);
    assert.equal(matchGlob('src/nested/a.ts', 'src/*.ts'), false);
    assert.equal(matchGlob('src/nested/a.ts', 'src/**/*.ts'), true);
  });

  it('lets * match the whole tree when the pattern has no slash', () => {
    assert.ok(globToRegExp('*').test('src/a.ts'));
    assert.equal(matchGlob('src/a.ts', '*'), true);
  });
});

describe('globTool', () => {
  it('returns files newest first and skips vendor directories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-glob-'));
    try {
      mkdirSync(join(root, 'src'));
      mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
      writeFileSync(join(root, 'src', 'old.ts'), 'old');
      writeFileSync(join(root, 'src', 'new.ts'), 'new');
      writeFileSync(join(root, 'node_modules', 'pkg', 'skip.ts'), 'skip');
      const older = Date.now() / 1000 - 60;
      utimesSync(join(root, 'src', 'old.ts'), older, older);
      const result = await globTool.execute({ pattern: '*.ts' }, ctx(root));
      assert.equal(result.ok, true);
      assert.equal(result.content, 'src/new.ts\nsrc/old.ts');
      assert.ok(!result.content.includes('node_modules'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('caps the inline page and says how many were omitted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-glob-cap-'));
    try {
      for (let i = 0; i < GLOB_MAX_RESULTS + 3; i++) {
        writeFileSync(join(root, `f${String(i).padStart(3, '0')}.txt`), 'x');
      }
      const result = await globTool.execute({ pattern: '*.txt' }, ctx(root));
      assert.equal(result.ok, true);
      assert.ok(result.content.includes(`Showing ${GLOB_MAX_RESULTS} of ${GLOB_MAX_RESULTS + 3}`));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns No files found when nothing matches', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-glob-empty-'));
    try {
      writeFileSync(join(root, 'a.ts'), '');
      const result = await globTool.execute({ pattern: '*.java' }, ctx(root));
      assert.equal(result.content, 'No files found');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
