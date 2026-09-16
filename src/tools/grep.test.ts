import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { grepTool } from './grep.js';
import { PathEscapeError } from '../workspace/boundary.js';
import type { ToolContext } from './types.js';

const NEEDLE = 'NEEDLE_MARKER_9f3a';

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

/**
 * 建一个指向 outside 的目录链接。
 *
 * 先试 junction：Windows 上目录联接不需要管理员权限或开发者模式，普通符号链接会 EPERM。
 * POSIX 上 junction 类型不存在（EINVAL），落到普通目录符号链接。
 */
function tryLinkDir(outside: string, linkPath: string): boolean {
  for (const type of ['junction', undefined] as const) {
    try {
      symlinkSync(outside, linkPath, type);
      return true;
    } catch {
      // 换下一种；都不行则由调用方跳过用例。
    }
  }
  return false;
}

describe('grepTool 工作区边界', () => {
  it('不下探符号链接：链到工作区外的目录不会被搜到', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'sph-grep-ws-'));
    const outside = mkdtempSync(join(tmpdir(), 'sph-grep-out-'));
    try {
      writeFileSync(join(root, 'inside.ts'), `const a = '${NEEDLE}';\n`);
      writeFileSync(join(outside, 'secret.ts'), `const b = '${NEEDLE}';\n`);
      if (!tryLinkDir(outside, join(root, 'link'))) {
        t.skip('本机不允许创建目录链接（Windows 需开发者模式或 junction 支持）');
        return;
      }

      // 先确认前提成立：链接确实通到外面（否则这个用例什么也没证明）。
      assert.ok(existsSync(join(root, 'link', 'secret.ts')), '前提校验：目录链接应当通到 outside');

      const result = await grepTool.execute({ pattern: NEEDLE }, ctx(root));
      assert.equal(result.ok, true);
      assert.ok(result.content.includes('inside.ts'), '工作区内的文件照常搜到');
      assert.equal(result.content.includes('secret.ts'), false, '不能透过符号链接搜到工作区外');
      assert.equal(result.content.includes('link'), false, '链接本身也不该作为命中被列出');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('把符号链接本身当 path 传入时被边界检查拒绝', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'sph-grep-ws2-'));
    const outside = mkdtempSync(join(tmpdir(), 'sph-grep-out2-'));
    try {
      writeFileSync(join(outside, 'secret.ts'), NEEDLE);
      if (!tryLinkDir(outside, join(root, 'link'))) {
        t.skip('本机不允许创建目录链接');
        return;
      }
      // 直接访问已经由 realpath 规范化后的边界判定挡住（真正漏的是递归那一条），
      // 这条用例把它钉住，免得以后有人把 assertInsideWorkspace 换成 resolve()。
      await assert.rejects(
        () => grepTool.execute({ pattern: NEEDLE, path: 'link' }, ctx(root)),
        PathEscapeError,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('普通文件与子目录照常搜索', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-grep-plain-'));
    try {
      mkdirSync(join(root, 'src', 'nested'), { recursive: true });
      writeFileSync(join(root, 'a.ts'), `x = '${NEEDLE}';\n`);
      writeFileSync(join(root, 'src', 'nested', 'b.ts'), `y = '${NEEDLE}';\n`);
      writeFileSync(join(root, 'src', 'c.ts'), 'nothing here\n');
      const result = await grepTool.execute({ pattern: NEEDLE }, ctx(root));
      assert.equal(result.ok, true);
      const lines = result.content.trim().split('\n');
      assert.equal(lines.length, 2);
      assert.ok(lines.some((line) => line.startsWith('a.ts:1:')));
      assert.ok(lines.some((line) => line.startsWith('src/nested/b.ts:1:')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
