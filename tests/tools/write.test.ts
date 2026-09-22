import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PathEscapeError } from '../../src/workspace/boundary.js';
import { EMPTY_PLUGIN_SERVICES } from '../../src/plugins/types.js';
import type { ToolContext } from '../../src/tools/types.js';
import { writeTool } from '../../src/tools/write.js';

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

function tryLinkDir(outside: string, linkPath: string): boolean {
  for (const type of ['junction', undefined] as const) {
    try {
      symlinkSync(outside, linkPath, type);
      return true;
    } catch {
      // 换下一种
    }
  }
  return false;
}

describe('writeTool 工作区边界', () => {
  it('经目录链接写出工作区外的新文件会被拒绝', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'sph-write-ws-'));
    const outside = mkdtempSync(join(tmpdir(), 'sph-write-out-'));
    try {
      if (!tryLinkDir(outside, join(root, 'link'))) {
        t.skip('本机不允许创建目录链接');
        return;
      }
      await assert.rejects(
        () => writeTool.execute({ path: 'link/pwned.txt', content: 'stolen' }, ctx(root)),
        PathEscapeError,
      );
      assert.equal(existsSync(join(outside, 'pwned.txt')), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('工作区内普通路径照常写入', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-write-ok-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      const result = await writeTool.execute({ path: 'src/a.txt', content: 'hello' }, ctx(root));
      assert.equal(result.ok, true);
      assert.equal(existsSync(join(root, 'src', 'a.txt')), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('报告的是 UTF-8 字节数，不是字符数', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-write-bytes-'));
    try {
      const result = await writeTool.execute({ path: 'a.txt', content: '中文' }, ctx(root));
      assert.equal(result.ok, true);
      assert.match(result.content, /\(6 bytes\)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
