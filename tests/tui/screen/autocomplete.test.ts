import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { CombinedAutocompleteProvider, findFdBinary } from '../../../src/tui/autocomplete.js';

const signal = () => new AbortController().signal;

describe('findFdBinary', () => {
  it('返回 PATH 上的 fd 或 null（不假装存在）', () => {
    const found = findFdBinary();
    assert.ok(found === null || typeof found === 'string');
  });
});

describe('@ 文件补全（无 fd 的内置回退）', () => {
  let root: string;
  let provider: CombinedAutocompleteProvider;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sph-autocomplete-'));
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'src', 'app.ts'), '');
    writeFileSync(join(root, 'src', 'util.ts'), '');
    writeFileSync(join(root, 'README.md'), '');
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), '');
    provider = new CombinedAutocompleteProvider([], root, null);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('@查询按文件名打分排序，跳过 node_modules', async () => {
    const result = await provider.getSuggestions(['@app'], 0, 4, { signal: signal() });
    assert.ok(result);
    assert.equal(result.items[0]!.value, '@src/app.ts');
    assert.equal(result.items[0]!.label, 'app.ts');
    assert.equal(result.items[0]!.description, 'src/app.ts');
    const paths = result.items.map((item) => item.description);
    assert.ok(!paths.some((path) => path?.includes('node_modules')));
  });

  it('空查询列出根目录条目，目录带 / 后缀', async () => {
    const result = await provider.getSuggestions(['@'], 0, 1, { signal: signal() });
    assert.ok(result);
    const labels = result.items.map((item) => item.label);
    assert.ok(labels.includes('src/'));
    assert.ok(labels.includes('README.md'));
  });

  it('目录候选应用后不加空格，可继续下钻', async () => {
    const result = await provider.getSuggestions(['@s'], 0, 2, { signal: signal() });
    assert.ok(result);
    const dir = result.items.find((item) => item.label === 'src/');
    assert.ok(dir);
    const applied = provider.applyCompletion(['@s'], 0, 2, dir, result.prefix);
    assert.equal(applied.lines[0], '@src/');
    assert.equal(applied.cursorCol, 5);
  });

  it('文件候选应用后补空格', async () => {
    const result = await provider.getSuggestions(['@src/u'], 0, 6, { signal: signal() });
    assert.ok(result);
    const applied = provider.applyCompletion(['@src/u'], 0, 6, result.items[0]!, result.prefix);
    assert.equal(applied.lines[0], '@src/util.ts ');
    assert.equal(applied.cursorCol, 13);
  });

  it('@" 引号前缀能补出带引号的值', async () => {
    writeFileSync(join(root, 'my file.ts'), '');
    const result = await provider.getSuggestions(['@"my f'], 0, 5, { signal: signal() });
    assert.ok(result);
    assert.equal(result.items[0]!.value, '@"my file.ts"');
  });

  it('Tab 强制路径补全走 readdir 单层', async () => {
    const result = await provider.getSuggestions(['src/'], 0, 4, { signal: signal(), force: true });
    assert.ok(result);
    const labels = result.items.map((item) => item.label);
    assert.deepEqual(labels, ['app.ts', 'util.ts']);
  });
});
