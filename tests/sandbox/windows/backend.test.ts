import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * 过滤令牌后端的生命周期与行为。
 *
 * 不再改任何目录的 DACL（旧 ACL 方案的授权/撤销链路已随受限 SID 列表一起移除——
 * 它与 msys/cygwin 的对象模型根本冲突，真 Git Bash 在受限令牌下活不过启动），
 * 所以这里直接在 tmpdir 上跑，不担心留痕。
 *
 * 「沙箱内跑真命令」的用例只在 Windows 上执行 bash：这曾是线上故障
 * （couldn't create signal pipe, Win32 error 5）的直接表现，值得常驻回归。
 */
describe(
  'Windows 过滤令牌沙箱',
  { skip: process.platform === 'win32' ? false : '只有 Windows 有过滤令牌后端' },
  () => {
    it('init 后 status 正确，dispose 可重复调用', async () => {
      const { WindowsAclSandbox } = await import('../../../src/sandbox/windows/backend.js');
      const workspace = mkdtempSync(join(tmpdir(), 'sph-token-ws-'));
      const sandbox = new WindowsAclSandbox({
        mode: 'workspace',
        workspaceRoot: workspace,
        sphHomeDir: workspace,
        tempDir: tmpdir(),
      });
      try {
        await sandbox.init();
        assert.equal(sandbox.status.mode, 'workspace');
        assert.equal(sandbox.status.enforcement, 'partial');
      } finally {
        sandbox.dispose();
        sandbox.dispose();
        rmSync(workspace, { recursive: true, force: true });
      }
    });

    it('沙箱内跑真 Git Bash 不再撞 signal pipe 初始化失败', { timeout: 60_000 }, async () => {
      const { WindowsAclSandbox } = await import('../../../src/sandbox/windows/backend.js');
      const { resolveBashBinary } = await import('../../../src/sandbox/shell-bin.js');
      const workspace = mkdtempSync(join(tmpdir(), 'sph-token-bash-'));
      writeFileSync(join(workspace, 'hello.txt'), 'hi');
      const sandbox = new WindowsAclSandbox({
        mode: 'workspace',
        workspaceRoot: workspace,
        sphHomeDir: workspace,
        tempDir: tmpdir(),
      });
      try {
        await sandbox.init();
        const bash = resolveBashBinary();
        const result = await sandbox.run({
          command: bash.command,
          args: [...bash.prefixArgs, 'cat hello.txt'],
          cwd: workspace,
          timeoutMs: 30_000,
        });
        assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
        assert.equal(result.stdout.trim(), 'hi');
      } finally {
        sandbox.dispose();
        rmSync(workspace, { recursive: true, force: true });
      }
    });
  },
);
