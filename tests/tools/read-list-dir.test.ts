import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { listDirTool } from '../../src/tools/list-dir.js';
import { readFileTool } from '../../src/tools/read-file.js';
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

describe('read 对目录输入的处理', () => {
  it('传目录时返回可读报错，而不是把 EISDIR 抛给调用方', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-read-dir-'));
    try {
      mkdirSync(join(root, 'sub'));
      const result = await readFileTool.execute({ path: 'sub' }, ctx(root));
      assert.equal(result.ok, false);
      assert.match(result.content, /not a file: sub/);
      assert.match(result.content, /use ls/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('ls 截断提示', () => {
  it('条目超过上限时说明总数与实际列出数', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-list-cap-'));
    try {
      for (let i = 0; i < 230; i++) writeFileSync(join(root, `f${String(i).padStart(3, '0')}.txt`), 'x');
      const result = await listDirTool.execute({ path: '.' }, ctx(root));
      assert.equal(result.ok, true);
      assert.match(result.content, /200 of 230 entries shown/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('未超上限时不加噪音提示', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-list-small-'));
    try {
      writeFileSync(join(root, 'a.txt'), 'x');
      const result = await listDirTool.execute({ path: '.' }, ctx(root));
      assert.equal(result.content.includes('entries shown'), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('跳过 node_modules 与 .git', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-list-skip-'));
    try {
      mkdirSync(join(root, 'node_modules'));
      mkdirSync(join(root, '.git'));
      mkdirSync(join(root, 'src'));
      const result = await listDirTool.execute({ path: '.' }, ctx(root));
      assert.equal(result.content.includes('node_modules'), false);
      assert.equal(result.content.includes('.git'), false);
      assert.ok(result.content.includes('src'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
