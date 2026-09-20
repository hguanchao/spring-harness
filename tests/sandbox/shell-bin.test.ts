import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolvePwshBinary, shellArgv } from '../../src/sandbox/shell-bin.js';

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
