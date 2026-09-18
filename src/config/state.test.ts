import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { addGrant, addTrustedWorkspace, parseGrants, parseRules, parseTrusted, readState } from './state.js';

const dirs: string[] = [];

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function configWith(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sph-state-'));
  dirs.push(dir);
  const path = join(dir, 'config.toml');
  writeFileSync(path, text, 'utf8');
  return path;
}

describe('trusted / grants / permissions 解析', () => {
  it('文件不存在时全部为空', () => {
    const state = readState(join(mkdtempSync(join(tmpdir(), 'x')), 'missing.toml'));
    assert.deepEqual(state.trusted, []);
    assert.deepEqual(state.grants, {});
    assert.deepEqual(state.rules, { allow: [], ask: [], deny: [] });
  });

  it('trusted 数组逐项校验', () => {
    assert.deepEqual(parseTrusted(undefined), []);
    assert.deepEqual(parseTrusted([' a ', 'b']), ['a', 'b']);
    assert.throws(() => parseTrusted('x'), /must be an array/);
    assert.throws(() => parseTrusted(['', 3]), /non-empty string/);
  });

  it('grants 表按作用域分桶，空键值丢弃', () => {
    assert.deepEqual(parseGrants({ 'E:\\demo': ['bash npm test', ' '] }), { 'E:\\demo': ['bash npm test'] });
    assert.throws(() => parseGrants('x'), /must be a table/);
    assert.throws(() => parseGrants({ demo: 'bash npm test' }), /must be an array/);
  });

  it('permissions 三张表与未知键', () => {
    assert.deepEqual(parseRules({ allow: ['a'], ask: ['b'], deny: ['c'] }), { allow: ['a'], ask: ['b'], deny: ['c'] });
    assert.deepEqual(parseRules(undefined), { allow: [], ask: [], deny: [] });
    assert.throws(() => parseRules({ allows: ['x'] }), /unknown permissions key/);
    assert.throws(() => parseRules('x'), /must be a table/);
  });
});

describe('写回 config.toml', () => {
  it('addTrustedWorkspace 追加到 trusted 数组，重复不写', () => {
    const path = configWith('provider = "p"\nmodel = "m"\ntrusted = ["E:\\\\a"]\n');
    addTrustedWorkspace('E:\\b', path);
    const parsed = parseToml(readFileSync(path, 'utf8')) as { trusted: string[] };
    assert.deepEqual(parsed.trusted, ['E:\\a', 'E:\\b']);
    addTrustedWorkspace('E:\\b', path);
    assert.deepEqual(parsed.trusted, ['E:\\a', 'E:\\b'], '重复信任不写第二遍');
  });

  it('trusted 不存在时新建键，且落在顶层而不是表体里', () => {
    const path = configWith('provider = "p"\nmodel = "m"\n\n[grants]\n"E:\\\\a" = ["k"]\n');
    addTrustedWorkspace('E:\\b', path);
    const parsed = parseToml(readFileSync(path, 'utf8')) as { trusted: string[]; grants: Record<string, string[]> };
    assert.deepEqual(parsed.trusted, ['E:\\b'], 'trusted 必须落在顶层');
    assert.deepEqual(parsed.grants['E:\\a'], ['k'], '不能挤掉已有的表');
  });

  it('addGrant 在 [grants] 表体内追加一行，同作用域累积', () => {
    const path = configWith('provider = "p"\nmodel = "m"\n\n[grants]\n"E:\\\\a" = ["bash npm test"]\n');
    addGrant('E:\\a', 'bash npm test', path);
    addGrant('E:\\a', 'mcp fs.read_file', path);
    const parsed = parseToml(readFileSync(path, 'utf8')) as { grants: Record<string, string[]> };
    assert.deepEqual(parsed.grants['E:\\a'], ['bash npm test', 'mcp fs.read_file']);
  });

  it('addGrant 在没有 [grants] 表时整表新建', () => {
    const path = configWith('provider = "p"\nmodel = "m"\n');
    addGrant('E:\\a', 'bash npm test', path);
    const parsed = parseToml(readFileSync(path, 'utf8')) as { grants: Record<string, string[]> };
    assert.deepEqual(parsed.grants['E:\\a'], ['bash npm test']);
  });

  it('config.toml 语法坏掉时读态直接报错，不静默清空', () => {
    const path = configWith('provider = "p"\n[grants]\nbroken');
    assert.throws(() => readState(path), /invalid/i, '解析失败必须抛错（fail-closed，不当作没有授权）');
  });
});
