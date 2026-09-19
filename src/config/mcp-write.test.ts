import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'smol-toml';
import { listSphMcpServers, removeSphMcpServer, setSphMcpPreference, splitCommandLine, upsertSphMcpServer } from './mcp-write.js';

function fixture(text: string): { path: string; read: () => string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sph-mcpwrite-'));
  const path = join(dir, 'config.toml');
  writeFileSync(path, text, 'utf8');
  return {
    path,
    read: () => readFileSync(path, 'utf8'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function toml(path: string): Record<string, unknown> {
  return parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

const EXISTING = [
  'base_url = "https://api.example.com/v1"',
  'model = "m"',
  '',
  '# 我的 MCP server',
  '[[mcp_servers]]',
  'name = "keep"',
  'command = "npx"          # 冷启动会比较慢',
  'args = ["-y", "keep-mcp"]',
  '',
].join('\n');

describe('upsertSphMcpServer', () => {
  it('新增时插在最后一个 [[mcp_servers]] 块之后，已有注释原样保留', () => {
    const f = fixture(EXISTING);
    try {
      assert.equal(upsertSphMcpServer(f.path, { name: 'fresh', command: 'node', args: ['s.js'] }).added, true);
      const text = f.read();
      assert.ok(text.includes('# 我的 MCP server'), '块前的注释不能被吃掉');
      assert.ok(text.indexOf('name = "keep"') < text.indexOf('name = "fresh"'), 'server 们放在一起');
      const servers = parse(text).mcp_servers as Array<Record<string, unknown>>;
      assert.deepEqual(servers.map((s) => s.name), ['keep', 'fresh']);
      assert.deepEqual(servers[1]?.args, ['s.js']);
    } finally {
      f.cleanup();
    }
  });

  it('已存在时只换 command/args 两行，行尾注释与块内其它键保留', () => {
    const f = fixture(EXISTING);
    try {
      assert.equal(upsertSphMcpServer(f.path, { name: 'keep', command: 'node', args: ['--x'] }).added, false);
      const text = f.read();
      assert.ok(text.includes('command = "node"          # 冷启动会比较慢'), '对齐与行尾注释都要留下');
      assert.ok(text.includes('args = ["--x"]'));
      assert.equal((text.match(/\[\[mcp_servers\]\]/g) ?? []).length, 1, '更新不该再造一个块');
    } finally {
      f.cleanup();
    }
  });

  it('块里缺 args 行时补在块尾', () => {
    const f = fixture('[[mcp_servers]]\nname = "a"\ncommand = "node"\n');
    try {
      upsertSphMcpServer(f.path, { name: 'a', command: 'node', args: ['x'] });
      const servers = toml(f.path).mcp_servers as Array<Record<string, unknown>>;
      assert.deepEqual(servers[0]?.args, ['x']);
      assert.equal((f.read().match(/\[\[mcp_servers\]\]/g) ?? []).length, 1, '补键不该再造一个块');
    } finally {
      f.cleanup();
    }
  });

  it('多行数组里的 [ 不被当成表头，后续块不受影响', () => {
    // 这是整份文件里最容易写错的一处：把 `args = [` 的续行当成表头，就会把块边界算错。
    const f = fixture(
      [
        '[[mcp_servers]]',
        'name = "a"',
        'command = "npx"',
        'args = [',
        '  "-y",',
        '  "a-mcp",',
        ']',
        '',
        '[[mcp_servers]]',
        'name = "b"',
        'command = "node"',
        '',
      ].join('\n'),
    );
    try {
      upsertSphMcpServer(f.path, { name: 'a', command: 'npx', args: ['-y', 'a2'] });
      const servers = toml(f.path).mcp_servers as Array<Record<string, unknown>>;
      assert.deepEqual(servers.map((s) => s.name), ['a', 'b'], 'b 的块必须还在');
      assert.deepEqual(servers[0]?.args, ['-y', 'a2']);
      assert.equal(servers[1]?.command, 'node');
    } finally {
      f.cleanup();
    }
  });

  it('本文件不存在时写出第一段配置', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sph-mcpwrite-new-'));
    const path = join(dir, 'config.toml');
    try {
      upsertSphMcpServer(path, { name: 'a', command: 'node' });
      assert.equal(readFileSync(path, 'utf8'), '\n[[mcp_servers]]\nname = "a"\ncommand = "node"\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('removeSphMcpServer', () => {
  it('删掉整个块并吸收空行，不留双空行', () => {
    const f = fixture(`${EXISTING}\n[[mcp_servers]]\nname = "gone"\ncommand = "x"\n`);
    try {
      assert.equal(removeSphMcpServer(f.path, 'gone'), true);
      const servers = toml(f.path).mcp_servers as Array<Record<string, unknown>>;
      assert.deepEqual(servers.map((s) => s.name), ['keep']);
      assert.ok(!/\n\n\n/.test(f.read()), '不该留下连续空行');
    } finally {
      f.cleanup();
    }
  });

  it('删中间那个块时，前后两块都完整', () => {
    const f = fixture(
      ['[[mcp_servers]]', 'name = "a"', 'command = "1"', '', '[[mcp_servers]]', 'name = "mid"', 'command = "2"', '', '[[mcp_servers]]', 'name = "c"', 'command = "3"', ''].join('\n'),
    );
    try {
      removeSphMcpServer(f.path, 'mid');
      const servers = toml(f.path).mcp_servers as Array<Record<string, unknown>>;
      assert.deepEqual(servers.map((s) => s.name), ['a', 'c']);
      assert.deepEqual(servers.map((s) => s.command), ['1', '3']);
    } finally {
      f.cleanup();
    }
  });

  it('名字不存在时返回 false 且不碰文件', () => {
    const f = fixture(EXISTING);
    try {
      const before = statSync(f.path).mtimeMs;
      assert.equal(removeSphMcpServer(f.path, 'nope'), false);
      assert.equal(f.read(), EXISTING);
      assert.equal(statSync(f.path).mtimeMs, before);
    } finally {
      f.cleanup();
    }
  });
});

describe('listSphMcpServers', () => {
  it('读出名字、命令与参数，含多行数组', () => {
    const f = fixture(
      ['[[mcp_servers]]', 'name = "a"', 'command = "npx"', 'args = [', '  "-y",', '  "a-mcp",', ']', ''].join('\n'),
    );
    try {
      assert.deepEqual(listSphMcpServers(f.path), [{ name: 'a', command: 'npx', args: ['-y', 'a-mcp'] }]);
    } finally {
      f.cleanup();
    }
  });

  it('没有 [[mcp_servers]] 时返回空表', () => {
    const f = fixture('base_url = "u"\nmodel = "m"\n');
    try {
      assert.deepEqual(listSphMcpServers(f.path), []);
    } finally {
      f.cleanup();
    }
  });
});

describe('setSphMcpPreference', () => {
  it('没有 [mcp] 表时新建一个', () => {
    const f = fixture('model = "m"\n');
    try {
      setSphMcpPreference(f.path, 'demo', { enabled: false, sourceEnabled: true });
      assert.deepEqual(toml(f.path).mcp, { disabled_servers: ['demo'], enabled_servers: [] });
    } finally {
      f.cleanup();
    }
  });

  it('关掉来源本来启用的条目：只进 disabled_servers', () => {
    const f = fixture('model = "m"\n\n[mcp]\ndisabled_servers = []\nenabled_servers = []\n');
    try {
      setSphMcpPreference(f.path, 'demo', { enabled: false, sourceEnabled: true });
      assert.deepEqual(toml(f.path).mcp, { disabled_servers: ['demo'], enabled_servers: [] });
    } finally {
      f.cleanup();
    }
  });

  it('打开来源自己声明关掉的条目：进 enabled_servers，不进 disabled_servers', () => {
    // 只写一个列表会让另一个留下过期的强制项，日后来源改了自己的默认值就会被它悄悄盖住。
    const f = fixture('model = "m"\n');
    try {
      setSphMcpPreference(f.path, 'demo', { enabled: true, sourceEnabled: false });
      assert.deepEqual(toml(f.path).mcp, { disabled_servers: [], enabled_servers: ['demo'] });
    } finally {
      f.cleanup();
    }
  });

  it('恢复来源默认：两个列表都不再留这个名字', () => {
    const f = fixture('model = "m"\n\n[mcp]\ndisabled_servers = ["demo"]\nenabled_servers = ["other"]\n');
    try {
      setSphMcpPreference(f.path, 'demo', { enabled: true, sourceEnabled: true });
      const mcp = toml(f.path).mcp as Record<string, string[]>;
      assert.deepEqual(mcp.disabled_servers, []);
      assert.deepEqual(mcp.enabled_servers, ['other'], '别的条目不该被牵连');
    } finally {
      f.cleanup();
    }
  });

  it('反复来回切不会累积重复项', () => {
    const f = fixture('model = "m"\n');
    try {
      setSphMcpPreference(f.path, 'demo', { enabled: false, sourceEnabled: true });
      setSphMcpPreference(f.path, 'demo', { enabled: false, sourceEnabled: true });
      setSphMcpPreference(f.path, 'demo', { enabled: true, sourceEnabled: true });
      setSphMcpPreference(f.path, 'demo', { enabled: false, sourceEnabled: true });
      assert.deepEqual(toml(f.path).mcp, { disabled_servers: ['demo'], enabled_servers: [] });
    } finally {
      f.cleanup();
    }
  });

  it('偏好写在顶层 [mcp] 里，不混进 server 表', () => {
    const f = fixture(EXISTING);
    try {
      setSphMcpPreference(f.path, 'keep', { enabled: false, sourceEnabled: true });
      const parsed = toml(f.path);
      assert.deepEqual(parsed.mcp, { disabled_servers: ['keep'], enabled_servers: [] });
      assert.deepEqual((parsed.mcp_servers as Array<Record<string, unknown>>).map((s) => s.name), ['keep']);
    } finally {
      f.cleanup();
    }
  });
});

describe('splitCommandLine', () => {
  it('按空白切分，第一段是 command', () => {
    assert.deepEqual(splitCommandLine('npx -y demo-mcp'), { command: 'npx', args: ['-y', 'demo-mcp'] });
    assert.deepEqual(splitCommandLine('  node   s.js  '), { command: 'node', args: ['s.js'] });
  });

  it('双引号包住的段可以含空格，引号本身不进结果', () => {
    // Windows 上可执行文件路径带空格非常常见，不处理就只能塞进 PATH 里的无空格路径。
    assert.deepEqual(splitCommandLine('"C:\\Program Files\\node\\node.exe" serve'), {
      command: 'C:\\Program Files\\node\\node.exe',
      args: ['serve'],
    });
    assert.deepEqual(splitCommandLine('npx --root "C:\\my dir"'), {
      command: 'npx',
      args: ['--root', 'C:\\my dir'],
    });
  });

  it('引号内的 \\" 是字面引号', () => {
    assert.deepEqual(splitCommandLine('sh -c "echo \\"hi\\""'), { command: 'sh', args: ['-c', 'echo "hi"'] });
  });

  it('引号未闭合返回 undefined，而不是猜一个切法', () => {
    assert.equal(splitCommandLine('npx "unclosed'), undefined);
  });

  it('空输入返回 undefined 而不是空 command', () => {
    assert.equal(splitCommandLine(''), undefined);
    assert.equal(splitCommandLine('   '), undefined);
    assert.equal(splitCommandLine('""'), undefined, '空引号段不该产生一个空命令');
  });

  it('反斜杠在引号外保持字面（不做 Windows 路径归一化）', () => {
    // 这里只是把用户敲的一行落进配置，通配符/变量展开都不该有语义。
    assert.deepEqual(splitCommandLine('C:\\tools\\srv.exe --flag'), {
      command: 'C:\\tools\\srv.exe',
      args: ['--flag'],
    });
  });
});
