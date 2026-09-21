import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { resolveBashBinary, resolvePwshBinary, shellArgv } from '../../src/sandbox/shell-bin.js';

describe('Windows PowerShell 启动参数', {
  skip: process.platform === 'win32' ? false : '只对 Windows 的 pwsh 启动器有意义',
}, () => {
  it('带 -ExecutionPolicy Bypass，避免机器策略拦住 npm.ps1', () => {
    const { prefixArgs } = resolvePwshBinary();
    const policyAt = prefixArgs.indexOf('-ExecutionPolicy');
    assert.ok(policyAt >= 0, '必须显式设 ExecutionPolicy');
    assert.equal(prefixArgs[policyAt + 1], 'Bypass');
    assert.ok(prefixArgs.includes('-NoProfile'));
    assert.ok(prefixArgs.includes('-NonInteractive'));
  });

  it('shellArgv 把 Bypass 传到实际 argv 里', () => {
    const { args } = shellArgv('npm test', 'pwsh');
    assert.equal(args[args.indexOf('-ExecutionPolicy') + 1], 'Bypass');
    assert.equal(args[args.length - 1], 'npm test');
  });
});

describe('Windows bash 解析', {
  skip: process.platform === 'win32' ? false : '只对 Windows 的 bash 解析有意义',
}, () => {
  const saved = {
    path: process.env.PATH,
    pathext: process.env.PATHEXT,
    systemRoot: process.env.SystemRoot,
  };
  let root: string;

  const setEnv = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  /** 造一个假文件，返回其绝对路径——解析只看路径存在性，不必是真二进制。 */
  const touch = (relative: string): string => {
    const file = join(root, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '');
    return file;
  };

  const resolved = (): string => resolveBashBinary().command.toLowerCase();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sph-shell-bin-'));
    process.env.PATHEXT = '.EXE;.CMD;.BAT';
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    setEnv('PATH', saved.path);
    setEnv('PATHEXT', saved.pathext);
    setEnv('SystemRoot', saved.systemRoot);
  });

  it('PATH 上只有 System32 的 WSL 入口时抛错，而不是把它当 bash', () => {
    process.env.SystemRoot = join(root, 'Windows');
    const wsl = touch(join('Windows', 'System32', 'bash.exe'));
    process.env.PATH = dirname(wsl);
    assert.throws(() => resolveBashBinary(), /Git Bash/);
  });

  it('PATH 上非系统的 bash 直接用', () => {
    const bash = touch(join('msys64', 'usr', 'bin', 'bash.exe'));
    process.env.PATH = dirname(bash);
    assert.equal(resolved(), bash.toLowerCase());
  });

  it('从 PATH 上的 git.exe 反推同装的 Git Bash', () => {
    const git = touch(join('Git', 'cmd', 'git.exe'));
    const bash = touch(join('Git', 'bin', 'bash.exe'));
    process.env.PATH = dirname(git);
    assert.equal(resolved(), bash.toLowerCase());
  });

  it('WSL 入口排在真 bash 之前时跳过它继续找', () => {
    process.env.SystemRoot = join(root, 'Windows');
    const wsl = touch(join('Windows', 'System32', 'bash.exe'));
    const bash = touch(join('Git', 'usr', 'bin', 'bash.exe'));
    process.env.PATH = [dirname(wsl), dirname(bash)].join(delimiter);
    assert.equal(resolved(), bash.toLowerCase());
  });
});
