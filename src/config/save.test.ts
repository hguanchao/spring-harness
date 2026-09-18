import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'smol-toml';
import { updateConfigFile, updateConfigTableEntry } from './save.js';

function fixture(text: string): { path: string; read: () => string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sph-save-'));
  const path = join(dir, 'config.toml');
  writeFileSync(path, text, 'utf8');
  return {
    path,
    read: () => readFileSync(path, 'utf8'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('updateConfigFile', () => {
  it('命中已有键时只换值，行尾注释与对齐原样保留', () => {
    const f = fixture('model   = "old"   # 主模型\nsandbox = "workspace"\n');
    try {
      updateConfigFile(f.path, { model: 'new' });
      assert.equal(f.read(), 'model   = "new"   # 主模型\nsandbox = "workspace"\n');
    } finally {
      f.cleanup();
    }
  });

  it('只命中被注释的模板行时就地取消注释，模板说明变成行尾注释', () => {
    const f = fixture('model = "m"\n# reasoning_effort = "medium"   # off | low | medium\n');
    try {
      const result = updateConfigFile(f.path, { reasoning_effort: 'high' });
      assert.equal(f.read(), 'model = "m"\nreasoning_effort = "high"   # off | low | medium\n');
      assert.deepEqual(result.added, [], '取消注释不算「新增」');
    } finally {
      f.cleanup();
    }
  });

  it('文件里没有的键追加到末尾', () => {
    const f = fixture('model = "m"\n');
    try {
      const result = updateConfigFile(f.path, { approval: 'yolo' });
      assert.equal(f.read(), 'model = "m"\napproval = "yolo"\n');
      assert.deepEqual(result.added, ['approval']);
    } finally {
      f.cleanup();
    }
  });

  it('文件以表结尾时，新键插到表头之前而不是文件末尾', () => {
    // 回归点：TOML 里表头之后的键属于该表，追加到末尾会把 `approval` 写成 `[mcp]` 的
    // `approval`——解析成功、值也在文件里，但顶层永远读不到。
    const f = fixture('base_url = "u"\nmodel = "m"\n\n[mcp]\ndisabled_servers = ["x"]\n');
    try {
      updateConfigFile(f.path, { approval: 'yolo' });
      const parsed = parse(f.read()) as Record<string, unknown>;
      assert.equal(parsed.approval, 'yolo', '必须落在顶层');
      assert.equal((parsed.mcp as Record<string, unknown>).approval, undefined, '不能漏进 [mcp]');
      assert.equal(f.read(), 'base_url = "u"\nmodel = "m"\napproval = "yolo"\n\n[mcp]\ndisabled_servers = ["x"]\n');
    } finally {
      f.cleanup();
    }
  });

  it('查找已有键时不看表体，避免把值写进同名但不是目标的键', () => {
    // `[aux]` 里也有一个 model：不限定查找范围就会改错那一份，而顶层 model 纹丝不动。
    const f = fixture('model = "main"\n\n[aux]\nmodel = "cheap"\n');
    try {
      updateConfigFile(f.path, { model: 'changed' });
      const parsed = parse(f.read()) as Record<string, unknown>;
      assert.equal(parsed.model, 'changed');
      assert.equal((parsed.aux as Record<string, unknown>).model, 'cheap');
    } finally {
      f.cleanup();
    }
  });

  it('一次多键：已有的就地改，没有的一起插到表头之前', () => {
    const f = fixture('model = "m"\n\n[aux]\nbase_url = "x"\n');
    try {
      updateConfigFile(f.path, { model: 'm2', approval: 'ask', subagent_max_depth: 2 });
      const parsed = parse(f.read()) as Record<string, unknown>;
      assert.equal(parsed.model, 'm2');
      assert.equal(parsed.approval, 'ask');
      assert.equal(parsed.subagent_max_depth, 2);
      assert.equal((parsed.aux as Record<string, unknown>).approval, undefined);
    } finally {
      f.cleanup();
    }
  });

  it('内容没变时不碰文件，避免无谓改动 mtime', () => {
    const f = fixture('model = "same"\n');
    try {
      const before = statSync(f.path).mtimeMs;
      updateConfigFile(f.path, { model: 'same' });
      assert.equal(statSync(f.path).mtimeMs, before);
    } finally {
      f.cleanup();
    }
  });

  it('空路径直接报错，不在 cwd 留下无主临时文件', () => {
    assert.throws(() => updateConfigFile('', { model: 'x' }), /config path is empty/);
  });

  it('换行风格跟随原文件（CRLF 不被改成 LF）', () => {
    const f = fixture('model = "m"\r\nsandbox = "workspace"\r\n');
    try {
      updateConfigFile(f.path, { approval: 'ask' });
      assert.ok(!/[^\r]\n/.test(f.read()), '每一处换行都应当是 CRLF');
    } finally {
      f.cleanup();
    }
  });

  it('数组值写入为单行 TOML 数组', () => {
    const f = fixture('provider = "p"\nmodel = "m"\n');
    try {
      updateConfigFile(f.path, { trusted: ['E:\\a', 'E:\\b'] });
      const parsed = parse(f.read()) as { trusted: string[] };
      assert.deepEqual(parsed.trusted, ['E:\\a', 'E:\\b']);
    } finally {
      f.cleanup();
    }
  });

  it('用户手工折成多行的数组被整段替换成单行，不留孤儿行', () => {
    const f = fixture('provider = "p"\nmodel = "m"\ntrusted = [\n  "E:\\\\a",\n  "E:\\\\b",\n]\n');
    try {
      updateConfigFile(f.path, { trusted: ['E:\\c'] });
      const parsed = parse(f.read()) as { trusted: string[] };
      assert.deepEqual(parsed.trusted, ['E:\\c'], '整段替换');
      assert.doesNotMatch(f.read(), /E:\\\\a/, '旧数组行不能残留');
    } finally {
      f.cleanup();
    }
  });
});

describe('updateConfigTableEntry', () => {
  it('表不存在时整表新建，键加引号渲染', () => {
    const f = fixture('provider = "p"\nmodel = "m"\n');
    try {
      updateConfigTableEntry(f.path, 'grants', 'E:\\a', ['shell npm test']);
      const parsed = parse(f.read()) as { provider: string; grants: Record<string, string[]> };
      assert.deepEqual(parsed.grants['E:\\a'], ['shell npm test']);
      assert.equal(parsed.provider, 'p', '已有内容不动');
    } finally {
      f.cleanup();
    }
  });

  it('同键重复写入是替换而不是追加；不同键累积', () => {
    const f = fixture('provider = "p"\n\n[grants]\n"E:\\\\a" = ["old"]\n');
    try {
      updateConfigTableEntry(f.path, 'grants', 'E:\\a', ['old', 'new']);
      updateConfigTableEntry(f.path, 'grants', 'E:\\b', ['x']);
      const parsed = parse(f.read()) as { grants: Record<string, string[]> };
      assert.deepEqual(parsed.grants['E:\\a'], ['old', 'new'], '同键替换');
      assert.deepEqual(parsed.grants['E:\\b'], ['x'], '不同键累积');
    } finally {
      f.cleanup();
    }
  });

  it('表体后的其它表不受影响；表头前没有可写位置也不写错地方', () => {
    const f = fixture('provider = "p"\nmodel = "m"\n\n[mcp]\ndisabled_servers = []\n');
    try {
      updateConfigTableEntry(f.path, 'grants', 'E:\\a', ['shell npm test']);
      const parsed = parse(f.read()) as { grants: Record<string, string[]>; mcp: Record<string, unknown> };
      assert.deepEqual(parsed.grants['E:\\a'], ['shell npm test'], 'grants 表追加在文件末尾');
      assert.equal(parsed.mcp.approval, undefined);
      assert.deepEqual((parsed.mcp as { disabled_servers: string[] }).disabled_servers, []);
    } finally {
      f.cleanup();
    }
  });

  it('表体内已有的多行数组值被整段替换', () => {
    const f = fixture('[grants]\n"E:\\\\a" = [\n  "one",\n  "two",\n]\n');
    try {
      updateConfigTableEntry(f.path, 'grants', 'E:\\a', ['three']);
      const parsed = parse(f.read()) as { grants: Record<string, string[]> };
      assert.deepEqual(parsed.grants['E:\\a'], ['three']);
      assert.doesNotMatch(f.read(), /two/, '旧值行不能残留');
    } finally {
      f.cleanup();
    }
  });
});
