import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { McpHub, type McpServerSpec } from './hub.js';

describe('McpHub 启动失败', () => {
  it('命令不存在时降级成问题记录，而不是把进程带走', async () => {
    // 回归点：spawn 失败走子进程的 'error' 事件，没有监听器时 EventEmitter 会把它升级成
    // 未捕获异常——配置里写错一个命令名就足以让 sph 起不来。启动路径必经 connect，
    // 所以这条必须被承接。此用例在修复前会让整个测试文件崩掉，而不是失败。
    // 握手改为后台完成后，失败经 onProblem 回调与 listServers().problem 露出。
    const hub = new McpHub();
    const problems: string[] = [];
    hub.onProblem = (message) => problems.push(message);
    try {
      await hub.connect([{ name: 'broken', command: 'definitely-not-a-real-binary-xyz' }]);
      await hub.whenReady();
      assert.equal(problems.length, 1);
      assert.match(problems[0] ?? '', /broken/);
      assert.match(hub.listServers()[0]?.problem ?? '', /failed to start/);
    } finally {
      hub.dispose();
    }
  });

  it('连不上的 server 仍出现在 listServers 里，供 /mcps 显示', async () => {
    const hub = new McpHub();
    try {
      await hub.connect([{ name: 'broken', command: 'definitely-not-a-real-binary-xyz', args: ['--flag'] }]);
      await hub.whenReady();
      const servers = hub.listServers();
      assert.equal(servers.length, 1, '遍历 entries 而非 connections：配了就要出现');
      assert.equal(servers[0]?.name, 'broken');
      assert.equal(servers[0]?.connected, false);
      assert.equal(servers[0]?.supported, true, 'stdio 是支持的传输');
      assert.equal(servers[0]?.enabled, true);
      assert.equal(servers[0]?.target, 'definitely-not-a-real-binary-xyz --flag');
      assert.match(servers[0]?.problem ?? '', /failed to start/, '连不上的原因要能看见');
      assert.deepEqual(servers[0]?.tools, []);
    } finally {
      hub.dispose();
    }
  });

  it('未配置任何 server 时 listServers 为空数组', () => {
    const hub = new McpHub();
    try {
      assert.deepEqual(hub.listServers(), []);
    } finally {
      hub.dispose();
    }
  });
});

/** 用 fixture 起一个真 server：`process.execPath` 免去对 PATH 的依赖。 */
const FIXTURE = fileURLToPath(new URL('./fixtures/minimal-server.mjs', import.meta.url));

function spec(name: string, extra: Partial<McpServerSpec> = {}): McpServerSpec {
  return { command: process.execPath, args: [FIXTURE], ...extra, name };
}

/** 让 server 报出自己的 pid，用来判断连接到底有没有被复用。 */
async function pidOf(hub: McpHub, name: string): Promise<number> {
  const raw = await hub.call(name, 'ping', {});
  const text = (JSON.parse(raw) as { content: Array<{ text: string }> }).content[0]?.text ?? '';
  return Number(/pid=(\d+)/.exec(text)?.[1]);
}

describe('McpHub 热重载', () => {
  it('签名未变的连接被复用：子进程 pid 不变', async () => {
    const hub = new McpHub();
    try {
      const first = await hub.reload([spec('echo')]);
      assert.deepEqual(first.added, ['echo']);
      const before = await pidOf(hub, 'echo');

      const again = await hub.reload([spec('echo')]);
      assert.deepEqual(again.added, [], '同名同签名不该被当成新增');
      assert.deepEqual(again.restarted, [], '也不该重启——全杀重连会让在跑的轮次直接失败');
      assert.equal(await pidOf(hub, 'echo'), before);
    } finally {
      hub.dispose();
    }
  });

  it('命令签名变化时重启连接', async () => {
    const hub = new McpHub();
    try {
      await hub.reload([spec('echo')]);
      const before = await pidOf(hub, 'echo');

      const changed = await hub.reload([spec('echo', { env: { SPH_TEST_LABEL: 'v2' } })]);
      assert.deepEqual(changed.restarted, ['echo'], 'env 变了意味着子进程形态变了');
      const raw = await hub.call('echo', 'ping', {});
      assert.match(raw, /label=v2/, '新连接应当吃到新 env');
      assert.notEqual(await pidOf(hub, 'echo'), before);
    } finally {
      hub.dispose();
    }
  });

  it('消失的条目被断开并关闭子进程', async () => {
    const hub = new McpHub();
    try {
      await hub.reload([spec('echo')]);
      const child = (hub as unknown as { connections: Map<string, { child: { pid?: number } }> })
        .connections.get('echo')?.child;
      const result = await hub.reload([]);
      assert.deepEqual(result.removed, ['echo']);
      assert.equal(hub.listServers().length, 0, '条目与连接都要清掉，不留孤儿');
      // 关掉的进程不该还活着：kill 是异步的，给一个极短的窗口再看。
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(isAlive(child?.pid), false);
    } finally {
      hub.dispose();
    }
  });

  it('禁用与 HTTP 条目不 spawn，但如实出现在 listServers 里', async () => {
    const hub = new McpHub();
    try {
      const result = await hub.reload([
        spec('off', { enabled: false }),
        { name: 'remote', url: 'https://mcp.example.com/mcp' },
      ]);
      assert.deepEqual(result.warnings, [], '不支持不是错误，启动时不该报警告');
      assert.deepEqual(result.added, []);

      const byName = new Map(hub.listServers().map((server) => [server.name, server]));
      assert.equal(byName.get('off')?.enabled, false);
      assert.equal(byName.get('off')?.problem, 'disabled');
      assert.equal(byName.get('remote')?.transport, 'http');
      assert.equal(byName.get('remote')?.supported, false);
      assert.match(byName.get('remote')?.problem ?? '', /stdio only/);
      assert.equal(byName.get('remote')?.target, 'https://mcp.example.com/mcp');
    } finally {
      hub.dispose();
    }
  });

  it('调用被禁用或不支持的 server 时给出可读原因，而不是静默失败', async () => {
    const hub = new McpHub();
    try {
      await hub.reload([spec('off', { enabled: false })]);
      await assert.rejects(() => hub.call('off', 'ping', {}), /unavailable.*disabled/);
      await assert.rejects(() => hub.call('nope', 'ping', {}), /not connected/);
    } finally {
      hub.dispose();
    }
  });
});

describe('McpHub 展示用的 target 打码', () => {
  /** `/mcps` 会把 target 打到屏幕上，而屏幕内容经常被截图或贴进 issue。 */
  async function target(specs: McpServerSpec[]): Promise<string> {
    const hub = new McpHub();
    try {
      await hub.reload(specs);
      return hub.listServers()[0]?.target ?? '';
    } finally {
      hub.dispose();
    }
  }

  it('紧跟 --api-key / --token 之类旗帜的值被打码', async () => {
    const shown = await target([{ name: 'c7', command: 'npx', args: ['-y', 'mcp', '--api-key', 'sk-live-abcd'] }]);
    assert.equal(shown, 'npx -y mcp --api-key ***');
    assert.equal(shown.includes('sk-live-abcd'), false);
  });

  it('KEY=value 形态只打码值，键名留着（否则不知道是哪个变量）', async () => {
    const shown = await target([
      { name: 's', command: 'run', args: ['GITHUB_TOKEN=ghp_x', 'MODE=fast'] },
    ]);
    assert.equal(shown, 'run GITHUB_TOKEN=*** MODE=fast');
  });

  it('普通参数不动，带空格的照样加引号', async () => {
    const shown = await target([
      { name: 'fs', command: 'npx', args: ['-y', '@mcp/server-filesystem', 'E:\\My Projects'] },
    ]);
    assert.equal(shown, 'npx -y @mcp/server-filesystem "E:\\My Projects"');
  });

  it('URL 里的凭据与疑似 token 查询参数被打码', async () => {
    const shown = await target([
      { name: 'r', url: 'https://user:pass@mcp.example.com/api?api_key=abc&mode=x' },
    ]);
    assert.equal(shown.includes('pass'), false);
    assert.equal(shown.includes('abc'), false);
    assert.match(shown, /mode=x/, '普通查询参数保留');
  });

  it('打码只发生在展示层：子进程仍然收到原值', async () => {
    // 「屏幕上看不到」和「真的没传进去」是两件事，只有问过子进程才算证明了前者。
    const hub = new McpHub();
    try {
      await hub.reload([
        { name: 'echo', command: process.execPath, args: [FIXTURE, '--api-key', 'sk-secret-value'] },
      ]);
      assert.match(hub.listServers()[0]?.target ?? '', /--api-key \*\*\*/);
      assert.match(await hub.call('echo', 'ping', {}), /sk-secret-value/);
    } finally {
      hub.dispose();
    }
  });
});

describe('启动不阻塞在握手上', () => {
  it('reload 立即返回（握手在后台），connecting 可见，whenReady 收口', async () => {
    const hub = new McpHub();
    try {
      const result = await hub.reload([spec('echo')]);
      assert.deepEqual(result.added, ['echo']);
      const rightAfter = hub.listServers()[0];
      assert.equal(rightAfter?.connecting, true, 'reload 返回时握手必然还在途');
      assert.equal(rightAfter?.connected, false);
      assert.equal(rightAfter?.tools.length, 0, '工具要等 tools/list 完成才有');

      await hub.whenReady();
      const settled = hub.listServers()[0];
      assert.equal(settled?.connected, true);
      assert.equal(settled?.connecting, undefined);
      assert.equal(settled?.tools.length > 0, true);
    } finally {
      hub.dispose();
    }
  });

  it('call 在握手在途时等待同一个连接，而不是叠出第二个子进程', async () => {
    const hub = new McpHub();
    try {
      await hub.reload([spec('echo')]); // 不 whenReady：故意在握手进行中调用
      const raw = await hub.call('echo', 'ping', {});
      assert.match(raw, /pid=\d+/);
      assert.equal(hub.listServers()[0]?.connected, true);
    } finally {
      hub.dispose();
    }
  });
});

function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('listTools 排序', () => {
  it('输出按 server + 工具名排序，与连接建立的顺序无关', async () => {
    const hub = new McpHub();
    try {
      // zeta 先连接：若按插入序输出，zeta 会排在 alpha 前面。
      await hub.reload([spec('zeta'), spec('alpha')]);
      await hub.whenReady();
      const tools = hub.listTools();
      assert.equal(tools.length, 2);
      assert.equal(tools[0]?.server, 'alpha');
      assert.equal(tools[1]?.server, 'zeta');
    } finally {
      hub.dispose();
    }
  });
});
