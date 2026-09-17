import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { FileObservation, NOT_OBSERVED } from './observe.js';
import type { ToolContext } from './types.js';
import { writeTool } from './write.js';
import { searchReplaceTool } from './search-replace.js';
import { readFileTool } from './read-file.js';

function ctx(root: string, observation: FileObservation): ToolContext {
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
    observation,
  };
}

describe('先读后写', () => {
  it('覆盖已有文件必须先 read_file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-obs-'));
    try {
      writeFileSync(join(root, 'a.txt'), 'old', 'utf8');
      const observation = new FileObservation();
      const c = ctx(root, observation);
      const denied = await writeTool.execute({ path: 'a.txt', content: 'new' }, c);
      assert.equal(denied.ok, false);
      assert.equal(denied.content, NOT_OBSERVED);
      const read = await readFileTool.execute({ path: 'a.txt' }, c);
      assert.equal(read.ok, true);
      const wrote = await writeTool.execute({ path: 'a.txt', content: 'new' }, c);
      assert.equal(wrote.ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('新建文件不必先读；随后 search_replace 可用', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-obs-new-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      const observation = new FileObservation();
      const c = ctx(root, observation);
      const wrote = await writeTool.execute({ path: 'src/b.txt', content: 'hello' }, c);
      assert.equal(wrote.ok, true);
      const edited = await searchReplaceTool.execute({
        path: 'src/b.txt',
        old_string: 'hello',
        new_string: 'world',
      }, c);
      assert.equal(edited.ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
