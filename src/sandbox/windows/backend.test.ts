import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * 在**临时目录**上跑完整的 ACL 生命周期（授权 → 撤销）。
 *
 * 刻意只用自己的临时目录：workspaceRoot / sphHomeDir / tempDir 全部指向 mkdtemp 出来的目录，
 * 绝不碰用户真实的工作区和 ~/.sph——这个后端会改 DACL，测试不该在别人机器上留痕。
 *
 * 能覆盖到的是「三条授权都登记、退出时都被撤销」这条链路（此前只撤销 temp，工作区与 ~/.sph
 * 的 ACE 永远留在盘上）。撤销后 DACL 的实际内容不在此处断言：读回 DACL 需要再引一套 Win32
 * 绑定，收益不抵成本；但「转换 SID → 合并 ACL → 写回 DACL → 释放 SID」这条 FFI 序列跑通
 * 已经能挡住顺序写错这类会崩进程的问题。
 */
describe(
  'WindowsAclSandbox ACL 生命周期',
  { skip: process.platform === 'win32' ? false : '只有 Windows 有 ACL 后端' },
  () => {
    it('init 授权后 dispose 撤销，且 dispose 可重复调用', async () => {
      // 动态 import 放在用例体内：win32.ts 在模块加载时就 koffi.load('kernel32.dll')，
      // 静态 import 会让这个文件在 Linux 上直接加载失败——即便用例本身被 skip 也救不回来。
      const { WindowsAclSandbox } = await import('./backend.js');
      const workspace = mkdtempSync(join(tmpdir(), 'sph-acl-ws-'));
      const sphHome = mkdtempSync(join(tmpdir(), 'sph-acl-home-'));
      const temp = mkdtempSync(join(tmpdir(), 'sph-acl-tmp-'));
      const sandbox = new WindowsAclSandbox({
        mode: 'workspace',
        workspaceRoot: workspace,
        sphHomeDir: sphHome,
        tempDir: temp,
      });
      try {
        await sandbox.init();
        assert.equal(sandbox.status.mode, 'workspace');
        assert.equal(sandbox.status.enforcement, 'partial');
      } finally {
        sandbox.dispose();
        sandbox.dispose();
        for (const dir of [workspace, sphHome, temp]) rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);

