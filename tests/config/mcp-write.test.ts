import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'smol-toml';
import { listSphMcpServers, removeSphMcpServer, setSphMcpDisabled, splitCommandLine, upsertSphMcpServer } from '../../src/config/mcp-write.js';

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
  '[mcp_servers.keep]',
  'type = "stdio"',
  'command = "npx"          # 冷启动会比较慢',
  'args = ["-y", "keep-mcp"]',
  '',
].join('\n');

describe('upsertSphMcpServer', () => {
  it('新增时插在最后一个 [mcp_servers.<name>] 之后，已有注释原样保留', () => {
    const f = fixture(EXISTING);
    try {
      assert.equal(upsertSphMcpServer(f.path, { name: 'fresh', command: 'node', args: ['s.js'] }).added, true);
      const text = f.read();
      assert.ok(text.includes('# 我的 MCP server'), '块前的注释不能被吃掉');
      assert.ok(text.indexOf('[mcp_servers.keep]') < text.indexOf('[mcp_servers.fresh]'), 'server 们放在一起');
      assert.ok(text.includes('type = "stdio"'));
      const servers = parse(text).mcp_servers as Record<string, Record<string, unknown>>;
      assert.deepEqual(Object.keys(servers), ['keep', 'fresh']);
      assert.deepEqual(servers.fresh?.args, ['s.js']);
      assert.equal(servers.fresh?.type, 'stdio');
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
      assert.equal((text.match(/\[mcp_servers\.keep\]/g) ?? []).length, 1, '更新不该再造一个块');
    } finally {
      f.cleanup();
    }
  });

  it('块里缺 args 行时补在块尾', () => {
    const f = fixture('[mcp_servers.a]\ntype = "stdio"\ncommand = "node"\n');
    try {
      upsertSphMcpServer(f.path, { name: 'a', command: 'node', args: ['x'] });
      const servers = toml(f.path).mcp_servers as Record<string, Record<string, unknown>>;
      assert.deepEqual(servers.a?.args, ['x']);
      assert.equal((f.read().match(/\[mcp_servers\.a\]/g) ?? []).length, 1, '补键不该再造一个块');
    } finally {
      f.cleanup();
    }
  });

  it('多行数组里的 [ 不被当成表头，后续块不受影响', () => {
    // 这是整份文件里最容易写错的一处：把 `args = [` 的续行当成表头，就会把块边界算错。
    const f = fixture(
      [
        '[mcp_servers.a]',
        'type = "stdio"',
        'command = "npx"',
        'args = [',
        '  "-y",',
        '  "a-mcp",',
        ']',
        '',
        '[mcp_servers.b]',
        'type = "stdio"',
        'command = "node"',
        '',
      ].join('\n'),
    );
    try {
      upsertSphMcpServer(f.path, { name: 'a', command: 'npx', args: ['-y', 'a2'] });
      const servers = toml(f.path).mcp_servers as Record<string, Record<string, unknown>>;
      assert.deepEqual(Object.keys(servers), ['a', 'b'], 'b 的块必须还在');
      assert.deepEqual(servers.a?.args, ['-y', 'a2']);
      assert.equal(servers.b?.command, 'node');
    } finally {
      f.cleanup();
    }
  });

  it('本文件不存在时写出第一段配置', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sph-mcpwrite-new-'));
    const path = join(dir, 'config.toml');
    try {
      upsertSphMcpServer(path, { name: 'a', command: 'node' });
      assert.equal(readFileSync(path, 'utf8'), '\n[mcp_servers.a]\ntype = "stdio"\ncommand = "node"\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('removeSphMcpServer', () => {
  it('删掉整个块并吸收空行，不留双空行', () => {
    const f = fixture(`${EXISTING}\n[mcp_servers.gone]\ntype = "stdio"\ncommand = "x"\n`);
    try {
      assert.equal(removeSphMcpServer(f.path, 'gone'), true);
      const servers = toml(f.path).mcp_servers as Record<string, Record<string, unknown>>;
      assert.deepEqual(Object.keys(servers), ['keep']);
      assert.ok(!/\n\n\n/.test(f.read()), '不该留下连续空行');
    } finally {
      f.cleanup();
    }
  });

  it('删中间那个块时，前后两块都完整', () => {
    const f = fixture(
      ['[mcp_servers.a]', 'type = "stdio"', 'command = "1"', '', '[mcp_servers.mid]', 'type = "stdio"', 'command = "2"', '', '[mcp_servers.c]', 'type = "stdio"', 'command = "3"', ''].join('\n'),
    );
    try {
      removeSphMcpServer(f.path, 'mid');
      const servers = toml(f.path).mcp_servers as Record<string, Record<string, unknown>>;
      assert.deepEqual(Object.keys(servers), ['a', 'c']);
      assert.deepEqual([servers.a?.command, servers.c?.command], ['1', '3']);
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
      ['[mcp_servers.a]', 'type = "stdio"', 'command = "npx"', 'args = [', '  "-y",', '  "a-mcp",', ']', ''].join('\n'),
    );
    try {
      assert.deepEqual(listSphMcpServers(f.path), [{ name: 'a', command: 'npx', args: ['-y', 'a-mcp'] }]);
    } finally {
      f.cleanup();
    }
  });

  it('没有 [mcp_servers.<name>] 时返回空表', () => {
    const f = fixture('base_url = "u"\nmodel = "m"\n');
    try {
      assert.deepEqual(listSphMcpServers(f.path), []);
    } finally {
      f.cleanup();
    }
  });
});

describe('setSphMcpDisabled', () => {
  it('关掉一个只有外部来源声明的 server：写一条只有 disabled 的同名标记', () => {
    const f = fixture('model = "m"\n');
    try {
      setSphMcpDisabled(f.path, 'demo', true);
      assert.deepEqual(toml(f.path).mcp_servers, { demo: { disabled: true } });
    } finally {
      f.cleanup();
    }
  });

  it('定义就在自己配置里时，只加一个 disabled 键，命令与注释都留着', () => {
    const f = fixture(EXISTING);
    try {
      setSphMcpDisabled(f.path, 'keep', true);
      const text = f.read();
      assert.ok(text.includes('command = "npx"          # 冷启动会比较慢'), '同一个块里的注释不能被动到');
      assert.ok(text.includes('args = ["-y", "keep-mcp"]'));
      const servers = toml(f.path).mcp_servers as Record<string, Record<string, unknown>>;
      assert.deepEqual(servers.keep?.disabled, true);
      assert.equal((text.match(/\[mcp_servers\.keep\]/g) ?? []).length, 1, '不该再造一个块');
    } finally {
      f.cleanup();
    }
  });

  it('已有的 disabled = false 就地改成 true，行尾注释留着', () => {
    const f = fixture('[mcp_servers.a]\ncommand = "node"\ndisabled = false   # 先观望着\n');
    try {
      setSphMcpDisabled(f.path, 'a', true);
      assert.ok(f.read().includes('disabled = true   # 先观望着'));
    } finally {
      f.cleanup();
    }
  });

  it('重新启用时删掉 disabled 键而不是写 false：默认本来就是启用', () => {
    const f = fixture('[mcp_servers.a]\ncommand = "node"\ndisabled = true\n');
    try {
      setSphMcpDisabled(f.path, 'a', false);
      const text = f.read();
      assert.equal(text.includes('disabled'), false);
      assert.equal(text, '[mcp_servers.a]\ncommand = "node"\n');
    } finally {
      f.cleanup();
    }
  });

  it('配置里还没有这个块时，启用要写出 disabled = false：缺省启用盖不住外部来源的禁用', () => {
    const f = fixture('model = "m"\n');
    try {
      setSphMcpDisabled(f.path, 'external', false);
      assert.deepEqual(toml(f.path).mcp_servers, { external: { disabled: false } });
    } finally {
      f.cleanup();
    }
  });

  it('重新启用一条纯禁用标记时连块一起删：不留没有定义的孤儿表', () => {
    const f = fixture('model = "m"\n\n[mcp_servers.gone]\ndisabled = true\n');
    try {
      setSphMcpDisabled(f.path, 'gone', false);
      assert.equal(f.read(), 'model = "m"\n');
    } finally {
      f.cleanup();
    }
  });

  it('已是启用态时启用（无 disabled 键）不碰文件，反复来回切不累积重复键', () => {
    const f = fixture(EXISTING);
    try {
      const before = statSync(f.path).mtimeMs;
      setSphMcpDisabled(f.path, 'keep', false);
      assert.equal(f.read(), EXISTING, '没有要改的东西就不写');
      assert.equal(statSync(f.path).mtimeMs, before);

      setSphMcpDisabled(f.path, 'keep', true);
      setSphMcpDisabled(f.path, 'keep', true);
      setSphMcpDisabled(f.path, 'keep', false);
      setSphMcpDisabled(f.path, 'keep', true);
      const text = f.read();
      assert.equal((text.match(/^\s*disabled\s*=/gm) ?? []).length, 1, '只该有一个 disabled 键');
      assert.ok(text.includes('disabled = true'));
    } finally {
      f.cleanup();
    }
  });

  it('相邻的块不受影响：改一个不会吃掉前面那份配置', () => {
    const f = fixture('[mcp_servers.a]\ncommand = "1"\n\n[mcp_servers.b]\ncommand = "2"\n');
    try {
      setSphMcpDisabled(f.path, 'a', true);
      const servers = toml(f.path).mcp_servers as Record<string, Record<string, unknown>>;
      assert.deepEqual(servers.a, { command: '1', disabled: true });
      assert.deepEqual(servers.b, { command: '2' });
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
