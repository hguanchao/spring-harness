import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bwrapProfileArgs, landlockGrants, seatbeltProfile, writableRoots } from '../../src/plugins/sph-sandbox/profile.js';
import { findBwrap } from '../../src/plugins/sph-sandbox/linux.js';
import { selectRunner } from '../../src/plugins/sph-sandbox/select.js';
import { SandboxError } from '../../src/sandbox/types.js';

describe('同机文件策略', () => {
  it('bwrap 把宿主根只读挂上，workspace 才放开工作区与临时目录', () => {
    const ro = bwrapProfileArgs('read-only', '/ws', '/tmp/s');
    const ws = bwrapProfileArgs('workspace', '/ws', '/tmp/s');
    assert.deepEqual(ro.slice(0, 10), ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']);
    assert.equal(ro.includes('--bind'), false);
    assert.ok(ws.includes('--tmpfs'));
    assert.deepEqual(ws.slice(ws.indexOf('--bind'), ws.indexOf('--bind') + 3), ['--bind', '/ws', '/ws']);
    assert.ok(ws.includes('/tmp/s'));
    assert.equal(ws.includes('--unshare-net'), false);
  });

  it('read-only 没有可写根；Landlock 仍放行 /dev/null', () => {
    assert.deepEqual(writableRoots('read-only', '/ws', '/tmp/s'), []);
    assert.deepEqual(landlockGrants('read-only', '/ws', '/tmp/s'), {
      readOnly: ['/'],
      readWrite: ['/dev/null'],
    });
    const ws = landlockGrants('workspace', '/ws', '/tmp/s');
    assert.deepEqual(ws.readWrite, ['/dev/null', '/ws', '/tmp/s', '/tmp']);
  });

  it('Seatbelt 默认允许，再按可写根放行写', () => {
    const ro = seatbeltProfile('read-only', '/ws', '/private/tmp/s');
    assert.ok(ro.includes('(allow default)'));
    assert.ok(ro.includes('(deny file-write*)'));
    assert.ok(ro.includes('(literal "/dev/null")'));
    assert.equal(ro.includes('subpath'), false);
    const ws = seatbeltProfile('workspace', '/ws', '/private/tmp/s');
    assert.ok(ws.includes('(subpath "/ws")'));
    assert.ok(ws.includes('(subpath "/private/tmp/s")'));
  });

  it('bwrap 只认固定路径，不扫 PATH', () => {
    assert.equal(findBwrap(() => false), undefined);
    assert.equal(findBwrap((path) => path === '/usr/bin/bwrap'), '/usr/bin/bwrap');
  });
});

describe('runner 选择', () => {
  it('按顺序留下第一个能用的', async () => {
    const chosen = await selectRunner([
      { id: 'bwrap' as const, usable: async () => false },
      { id: 'landlock' as const, usable: async () => true },
    ]);
    assert.equal(chosen, 'landlock');
  });

  it('都不可用就拒绝，不退回无围栏', async () => {
    await assert.rejects(
      () => selectRunner([{ id: 'bwrap' as const, usable: async () => false }]),
      (error: unknown) => error instanceof SandboxError && /pass --sandbox off/.test(error.message),
    );
  });
});
