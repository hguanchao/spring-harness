import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse as parseToml } from 'smol-toml';
import { createGrantStore, permissionScopeRoot } from '../../src/permission/store.js';

/** 造一棵临时目录树；`git` 时在根上放 `.git`，`sub` 时再建一层子目录。 */
function tempTree(options: { git?: boolean; sub?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'sph-perm-'));
  if (options.git) mkdirSync(join(root, '.git'), { recursive: true });
  if (options.sub) mkdirSync(join(root, options.sub), { recursive: true });
  return root;
}

/** 造一份最小可解析的 config.toml；grants 存在这里而不是单独的 JSON。 */
function configWith(root: string, text = ''): string {
  const file = join(root, 'config.toml');
  writeFileSync(file, `provider = "p"\nmodel = "m"\n${text}`, 'utf8');
  return file;
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
    const file = configWith(root);
    try {
      const store = createGrantStore(root, file);
      assert.deepEqual([...store.load()], []);
      store.add('bash npm test');
      store.add('bash npm test');
      assert.deepEqual([...store.load()], ['bash npm test']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('写一个作用域不会抹掉别的作用域', () => {
    const a = tempTree({ git: true });
    const b = tempTree({ git: true });
    const file = configWith(a);
    try {
      createGrantStore(a, file).add('bash npm test');
      createGrantStore(b, file).add('bash cargo test');
      assert.deepEqual([...createGrantStore(a, file).load()], ['bash npm test']);
      assert.deepEqual([...createGrantStore(b, file).load()], ['bash cargo test']);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('授权落在 [grants] 表里，且不破坏 config.toml 其余内容', () => {
    const root = tempTree({ git: true });
    const file = configWith(root, '\n[permissions]\nallow = ["bash:npm test"]\n');
    try {
      createGrantStore(root, file).add('bash npm test');
      const parsed = parseToml(readFileSync(file, 'utf8')) as {
        provider: string;
        permissions: { allow: string[] };
        grants: Record<string, string[]>;
      };
      assert.equal(parsed.provider, 'p', 'provider 键原样保留');
      assert.deepEqual(parsed.permissions.allow, ['bash:npm test'], '[permissions] 规则原样保留');
      const scope = permissionScopeRoot(root);
      assert.deepEqual(parsed.grants[scope], ['bash npm test'], 'grants 以作用域根为键写入');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('config.toml 语法坏掉时读取直接报错，不静默当作没有授权', () => {
    const root = tempTree({ git: true });
    const file = configWith(root);
    writeFileSync(file, 'provider = "p"\n[grants]\nbroken', 'utf8');
    try {
      assert.throws(() => createGrantStore(root, file).load());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
