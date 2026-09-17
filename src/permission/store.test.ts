import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createGrantStore, permissionScopeRoot } from './store.js';

/** 造一棵临时目录树；`git` 时在根上放 `.git`，`sub` 时再建一层子目录。 */
function tempTree(options: { git?: boolean; sub?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'sph-perm-'));
  if (options.git) mkdirSync(join(root, '.git'), { recursive: true });
  if (options.sub) mkdirSync(join(root, options.sub), { recursive: true });
  return root;
}

describe('permissionScopeRoot', () => {
  it('在仓库内取仓库根：子目录与仓库根落在同一作用域', () => {
    const root = tempTree({ git: true, sub: join('packages', 'app') });
    try {
      assert.equal(
        permissionScopeRoot(join(root, 'packages', 'app')),
        permissionScopeRoot(root),
        '在子目录里批准的动作，从仓库根启动的会话也必须看得到',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('不在仓库里：作用域就是工作区根本身，两个目录互不相干', () => {
    const a = tempTree();
    const b = tempTree();
    try {
      assert.notEqual(permissionScopeRoot(a), permissionScopeRoot(b));
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('$HOME 上的仓库退回工作区根，不把授权发给整个家目录', () => {
    const home = tempTree({ git: true, sub: 'project' });
    try {
      const project = join(home, 'project');
      assert.notEqual(
        permissionScopeRoot(project, home),
        permissionScopeRoot(home, home),
        '按仓库根分键会得到 $HOME 本身——那等于给整个家目录发授权',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('createGrantStore', () => {
  it('写进去的授权能读回来，重复批准不写重复项', () => {
    const root = tempTree({ git: true });
    const file = join(root, 'permissions.json');
    try {
      const store = createGrantStore(root, file);
      assert.deepEqual([...store.load()], []);
      store.add('shell npm test');
      store.add('shell npm test');
      assert.deepEqual([...store.load()], ['shell npm test']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('写一个作用域不会抹掉别的作用域', () => {
    const a = tempTree({ git: true });
    const b = tempTree({ git: true });
    const file = join(a, 'permissions.json');
    try {
      createGrantStore(a, file).add('shell npm test');
      createGrantStore(b, file).add('shell cargo test');
      assert.deepEqual([...createGrantStore(a, file).load()], ['shell npm test']);
      assert.deepEqual([...createGrantStore(b, file).load()], ['shell cargo test']);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('坏文件当「没有任何授权」，不抛错且下次写入能自愈', () => {
    const root = tempTree({ git: true });
    const file = join(root, 'permissions.json');
    try {
      writeFileSync(file, '{ not json at all', 'utf8');
      assert.deepEqual([...createGrantStore(root, file).load()], [], 'fail-closed：读不回来只会多问几次');
      createGrantStore(root, file).add('shell npm test');
      assert.deepEqual([...createGrantStore(root, file).load()], ['shell npm test']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
