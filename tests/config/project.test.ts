import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { parse as parseToml } from 'smol-toml';
import { appendProjectAllowRule, loadProjectPermissions, projectConfigPath } from '../../src/config/project.js';
import { createPermissionRuntime } from '../../src/permission/runtime.js';

const dirs: string[] = [];

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function workspace(text?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'sph-project-'));
  dirs.push(root);
  if (text !== undefined) {
    mkdirSync(join(root, '.sph'), { recursive: true });
    writeFileSync(projectConfigPath(root), text, 'utf8');
  }
  return root;
}

describe('项目级配置', () => {
  it('没有文件时不报错', () => {
    assert.equal(loadProjectPermissions(workspace(), true), undefined);
  });

  it('[permissions] 与 [mcp_servers] 可以写在同一份文件里', () => {
    const root = workspace('[permissions]\ndeny = ["read(*.env)"]\n\n[mcp_servers.demo]\ncommand = "demo"\n');
    const loaded = loadProjectPermissions(root, true);
    assert.deepEqual(loaded?.rules.deny, ['read(*.env)']);
  });

  it('模型、审批这类键仍然拒绝：项目配置不该改运行参数', () => {
    const root = workspace('model = "x"\n\n[permissions]\ndeny = ["bash(rm *)"]\n');
    assert.throws(() => loadProjectPermissions(root, true), /may only set \[permissions\] and \[mcp_servers\]/);
  });

  it('文件坏掉时拒绝追加，而不是用空 allow 把原文件盖掉', () => {
    const root = workspace('[permissions]\ndeny = [\n');
    const before = readFileSync(projectConfigPath(root), 'utf8');
    assert.throws(() => appendProjectAllowRule(root, 'bash(npm *)'));
    assert.equal(readFileSync(projectConfigPath(root), 'utf8'), before);
  });

  it('项目配置还不存在时，追加的规则立刻出现在内存分层里', () => {
    const root = workspace();
    const runtime = createPermissionRuntime({
      workspaceRoot: root,
      userRules: { allow: [], ask: [], deny: [] },
      userRulesDir: join(root, 'user'),
      home: join(root, 'home'),
      sandboxMode: 'off',
      sandboxAutoAllow: false,
      trusted: true,
    });
    assert.equal(runtime.addProjectRule('bash(npm *)').added, true);
    assert.deepEqual(runtime.layers().project?.rules.allow, ['bash(npm *)']);
    const parsed = parseToml(readFileSync(projectConfigPath(root), 'utf8')) as {
      permissions: { allow: string[] };
    };
    assert.deepEqual(parsed.permissions.allow, ['bash(npm *)']);
  });
});
