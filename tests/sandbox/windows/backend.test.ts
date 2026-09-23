import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * Windows 沙箱后端：双令牌分档的生命周期与行为。
 *
 * - pwsh → 受限令牌 + ACL 写围栏（能力 SID 授权工作区/私有临时目录）：跑真实 pwsh
 *   验证工作区可写、工作区外被拒。
 * - bash → 过滤令牌：msys/cygwin 与受限 SID 列表根本冲突，跑真实 Git Bash 验证它
 *   活得过初始化——这曾是线上故障（couldn't create signal pipe, Win32 error 5）。
 *
 * 刻意只用自己的临时目录：workspaceRoot / sphHomeDir / tempDir 全部指向 mkdtemp
 * 出来的目录，绝不碰用户真实的工作区和 ~/.sph——这个后端会改 DACL，测试不该在
 * 别人机器上留痕。
 */
describe(
  'Windows 沙箱双令牌分档',
  { skip: process.platform === 'win32' ? false : '只有 Windows 有双令牌后端' },
  () => {
    it('init 后 status 正确，dispose 可重复调用', async () => {
      const { WindowsAclSandbox } = await import('../../../src/plugins/sph-sandbox/windows/backend.js');
      const workspace = mkdtempSync(join(tmpdir(), 'sph-token-ws-'));
      const temp = mkdtempSync(join(tmpdir(), 'sph-token-tmp-'));
      const sandbox = new WindowsAclSandbox({
        mode: 'workspace',
        workspaceRoot: workspace,
        sphHomeDir: workspace,
        tempDir: temp,
      });
      try {
        await sandbox.init();
        assert.equal(sandbox.status.mode, 'workspace');
        assert.equal(sandbox.status.enforcement, 'partial');
      } finally {
        sandbox.dispose();
        sandbox.dispose();
        rmSync(workspace, { recursive: true, force: true });
        rmSync(temp, { recursive: true, force: true });
      }
    });

    it('tokenTierFor 按 shell 二进制分档：bash 走过滤档，pwsh/未知走受限档', async () => {
      const { tokenTierFor } = await import('../../../src/plugins/sph-sandbox/windows/backend.js');
      assert.equal(tokenTierFor('C:\\Program Files\\Git\\usr\\bin\\bash.exe'), 'filtered');
      assert.equal(tokenTierFor('D:\\tools\\sh.exe'), 'filtered');
      assert.equal(tokenTierFor('C:\\Program Files\\PowerShell\\7\\pwsh.exe'), 'restricted');
      assert.equal(tokenTierFor('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.EXE'), 'restricted');
      assert.equal(tokenTierFor('C:\\other\\python.exe'), 'restricted', '未知二进制按围栏意图归入受限档');
    });

    it('沙箱内跑真 Git Bash 不再撞 signal pipe 初始化失败', { timeout: 60_000 }, async () => {
      const { WindowsAclSandbox } = await import('../../../src/plugins/sph-sandbox/windows/backend.js');
      const { resolveBashBinary } = await import('../../../src/sandbox/shell-bin.js');
      const workspace = mkdtempSync(join(tmpdir(), 'sph-token-bash-'));
      const temp = mkdtempSync(join(tmpdir(), 'sph-token-bash-tmp-'));
      writeFileSync(join(workspace, 'hello.txt'), 'hi');
      const sandbox = new WindowsAclSandbox({
        mode: 'workspace',
        workspaceRoot: workspace,
        sphHomeDir: workspace,
        tempDir: temp,
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
        rmSync(temp, { recursive: true, force: true });
      }
    });
  },
);

/** pwsh 的可用性只认真实调用：where/exists 都可能说谎（只看退出状态）。 */
async function pwshCommand(): Promise<{ command: string; prefixArgs: string[] } | undefined> {
  try {
    const { resolvePwshBinary } = await import('../../../src/sandbox/shell-bin.js');
    return resolvePwshBinary();
  } catch {
    return undefined;
  }
}

describe(
  'Windows 受限档写围栏（真实 pwsh）',
  {
    skip: process.platform === 'win32' && (await pwshCommand()) !== undefined
      ? false
      : `只有 Windows 且装有 pwsh 才能跑（platform=${process.platform}）`,
  },
  () => {
    it('工作区内可写、工作区外被拒，TMP 指向沙箱私有临时目录', { timeout: 90_000 }, async () => {
      const { WindowsAclSandbox } = await import('../../../src/plugins/sph-sandbox/windows/backend.js');
      const shell = await pwshCommand();
      assert.ok(shell, 'pwsh 不可用则本用例应被 skip');
      const workspace = mkdtempSync(join(tmpdir(), 'sph-fence-ws-'));
      const temp = mkdtempSync(join(tmpdir(), 'sph-fence-tmp-'));
      // 围栏外的落点：一个沙箱**没有**授权过的目录（沙箱临时目录带 tmpSid 授权，本就可写）。
      const outside = mkdtempSync(join(tmpdir(), 'sph-fence-out-'));
      const sandbox = new WindowsAclSandbox({
        mode: 'workspace',
        workspaceRoot: workspace,
        sphHomeDir: workspace,
        tempDir: temp,
      });
      try {
        await sandbox.init();

        // 工作区内写：受限检查被能力 SID ACE 放行。
        const inside = await sandbox.run({
          command: shell.command,
          args: [...shell.prefixArgs, "Set-Content -LiteralPath 'inside.txt' -Value 'ok'"],
          cwd: workspace,
          timeoutMs: 60_000,
        });
        assert.equal(inside.exitCode, 0, `stderr: ${inside.stderr}`);
        assert.equal(readFileSync(join(workspace, 'inside.txt'), 'utf8').trim(), 'ok');

        // 工作区外写：正常检查过（用户有权限）但受限检查无能力 ACE，必须被拒。
        const outsideResult = await sandbox.run({
          command: shell.command,
          args: [...shell.prefixArgs, `Set-Content -LiteralPath '${join(outside, 'out.txt')}' -Value 'x'`],
          cwd: workspace,
          timeoutMs: 60_000,
        });
        assert.notEqual(outsideResult.exitCode, 0, `工作区外写不应成功，stderr: ${outsideResult.stderr}`);
        assert.ok(!existsSync(join(outside, 'out.txt')), '工作区外不应真的出现文件');

        // TMP/TEMP 被重写到私有临时目录：pwsh 程序集探针才能落进已授权位置。
        const env = await sandbox.run({
          command: shell.command,
          args: [...shell.prefixArgs, '$env:TEMP'],
          cwd: workspace,
          timeoutMs: 60_000,
        });
        assert.equal(env.exitCode, 0, `stderr: ${env.stderr}`);
        assert.ok(env.stdout.trim().startsWith(temp), `TEMP 应指向沙箱临时目录，实际: ${env.stdout.trim()}`);
      } finally {
        sandbox.dispose();
        rmSync(workspace, { recursive: true, force: true });
        rmSync(temp, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it('abort 终止子进程，而不是只停止等待', { timeout: 45_000 }, async () => {
      const { WindowsAclSandbox } = await import('../../../src/plugins/sph-sandbox/windows/backend.js');
      const shell = await pwshCommand();
      assert.ok(shell, 'pwsh 不可用则本用例应被 skip');
      const workspace = mkdtempSync(join(tmpdir(), 'sph-abort-ws-'));
      const temp = mkdtempSync(join(tmpdir(), 'sph-abort-tmp-'));
      const sandbox = new WindowsAclSandbox({
        mode: 'workspace',
        workspaceRoot: workspace,
        sphHomeDir: workspace,
        tempDir: temp,
      });
      const started = join(workspace, 'started');
      const marker = join(workspace, 'marker');
      try {
        await sandbox.init();
        const abort = new AbortController();
        // 忙等写在 pwsh 进程自己里面：杀掉它之后没有子进程会去补写 marker。
        const script = [
          "Set-Content -LiteralPath 'started' -Value go",
          '$end = (Get-Date).AddSeconds(8)',
          'while ((Get-Date) -lt $end) {}',
          "Set-Content -LiteralPath 'marker' -Value leaked",
        ].join('; ');
        const pending = sandbox.run({
          command: shell.command,
          args: [...shell.prefixArgs, script],
          cwd: workspace,
          timeoutMs: 30_000,
          signal: abort.signal,
        });
        const deadline = Date.now() + 20_000;
        while (!existsSync(started)) {
          if (Date.now() > deadline) throw new Error('pwsh did not start');
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        abort.abort();
        const result = await pending;
        assert.equal(result.exitCode, 1);
        // 若只是不再等待，忙等结束后 marker 会出现。
        await new Promise((resolve) => setTimeout(resolve, 12_000));
        assert.equal(existsSync(marker), false);
      } finally {
        sandbox.dispose();
        rmSync(workspace, { recursive: true, force: true });
        rmSync(temp, { recursive: true, force: true });
      }
    });
  },
);
