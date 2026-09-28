import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createGrantStore, permissionScopeRoot } from '../../src/permission/store.js';

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

describe('createGrantStore（.sph/permissions.json）', () => {
  it('写进去的授权能读回来，重复批准不写重复项', () => {
    const root = tempTree({ git: true });
    try {
      const store = createGrantStore(root);
      assert.deepEqual([...store.load()], []);
      store.add('bash npm test');
      store.add('bash npm test');
      assert.deepEqual([...store.load()], ['bash npm test']);
      assert.equal(store.path, join(root, '.sph', 'permissions.json'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('不同项目各自一份文件，互不串味', () => {
    const a = tempTree({ git: true });
    const b = tempTree({ git: true });
    try {
      createGrantStore(a).add('bash npm test');
      createGrantStore(b).add('bash cargo test');
      assert.deepEqual([...createGrantStore(a).load()], ['bash npm test']);
      assert.deepEqual([...createGrantStore(b).load()], ['bash cargo test']);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('首次写入时把授权文件追加进项目 .gitignore（授权不入库）', () => {
    const root = tempTree({ git: true });
    try {
      writeFileSync(join(root, '.gitignore'), 'node_modules/\n', 'utf8');
      createGrantStore(root).add('bash npm test');
      const text = readFileSync(join(root, '.gitignore'), 'utf8');
      assert.ok(text.includes('node_modules/'), '原有内容原样保留');
      assert.ok(text.includes('.sph/permissions.json'), '追加授权文件一行');
      // 第二次写入不重复追加。
      createGrantStore(root).add('bash cargo test');
      const after = readFileSync(join(root, '.gitignore'), 'utf8');
      assert.equal((after.match(/sph\/permissions\.json/g) ?? []).length, 1, '已有条目就不重复追加');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('坏文件按空集合处理并给出警告：丢授权只会多问一次，方向安全', () => {
    const root = tempTree({ git: true });
    try {
      createGrantStore(root).add('bash npm test');
      writeFileSync(join(root, '.sph', 'permissions.json'), '{ not json', 'utf8');
      const store = createGrantStore(root);
      assert.deepEqual([...store.load()], []);
      assert.match(store.warning() ?? '', /treated as no grants/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('不在 git 仓库里时不碰 .gitignore（没有可提交的东西）', () => {
    const root = tempTree();
    try {
      createGrantStore(root).add('bash npm test');
      assert.equal(existsSync(join(root, '.gitignore')), false);
      assert.equal(existsSync(join(root, '.sph', 'permissions.json')), true, '授权文件照常写');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
