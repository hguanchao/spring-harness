import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { McpHub, stopStdioChild } from '../../src/plugins/sph-mcp/hub.js';
import { testHostFacts } from '../plugins/host-fixture.js';
import { cmdArgumentLine, escapeCmdArgument, resolveWindowsCommand } from '../../src/plugins/sph-mcp/win-command.js';

describe('escapeCmdArgument', () => {
  it('普通参数包双引号（外层引号同样要过 meta 转义）', () => {
    assert.equal(escapeCmdArgument('hello'), '^"hello^"');
  });

  it('空格保留在引号里', () => {
    assert.equal(escapeCmdArgument('a b'), '^"a b^"');
  });

  it('cmd 元字符（含引号自身）前插 ^', () => {
    // ^ 是 cmd /c 解析层的转义符；引号也是元字符，第 1 步加上的引号同样要转义。
    assert.equal(escapeCmdArgument('a&b'), '^"a^&b^"');
    assert.equal(escapeCmdArgument('say "hi"'), '^"say \\^"hi\\^"^"');
  });

  it('引号前的反斜杠翻倍（CommandLineToArgvW 层），随后引号转义', () => {
    // `\"` → argv 层翻成 `\\"` → 包引号 → meta 层给每个引号插 ^。
    assert.equal(escapeCmdArgument('pre\\"post'), '^"pre\\\\\\^"post^"');
  });

  it('末尾反斜杠翻倍，防止吃掉收尾引号', () => {
    // `C:\temp\` → 末尾反斜杠翻倍成 `\\` → 包引号 → 引号转义。
    assert.equal(escapeCmdArgument('C:\\temp\\'), '^"C:\\temp\\\\^"');
  });
});

describe('cmdArgumentLine', () => {
  it('file + args 各自转义后拼接；引号全部过 meta 转义', () => {
    const line = cmdArgumentLine('C:\\node\\npx.cmd', ['-y', '@scope/pkg']);
    assert.match(line, /\^"C:\\node\\npx\.cmd\^"/);
    assert.match(line, /\^"-y\^"/);
    assert.match(line, /\^"@scope\/pkg\^"/);
  });
});

describe('resolveWindowsCommand（注入 env，任何平台可跑）', () => {
  function sandbox(): { dir: string; env: NodeJS.ProcessEnv; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'sph-win-cmd-'));
    return {
      dir,
      env: { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' } as NodeJS.ProcessEnv,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  it('按 PATHEXT 逐个补试，批处理标记 viaCmd', () => {
    const s = sandbox();
    try {
      writeFileSync(join(s.dir, 'tool.cmd'), '@echo off\r\n');
      const resolved = resolveWindowsCommand('tool', s.env);
      assert.ok(resolved);
      assert.equal(resolved.viaCmd, true);
      assert.equal(resolved.file, join(s.dir, 'tool.cmd'));
    } finally {
      s.cleanup();
    }
  });

  it('PATHEXT 顺序生效：app.com 与 app.exe 并存时 .COM 先中', () => {
    const s = sandbox();
    try {
      writeFileSync(join(s.dir, 'app.com'), 'x');
      writeFileSync(join(s.dir, 'app.exe'), 'x');
      const resolved = resolveWindowsCommand('app', s.env);
      assert.equal(resolved?.file, join(s.dir, 'app.com'));
      assert.equal(resolved?.viaCmd, false);
    } finally {
      s.cleanup();
    }
  });

  it('无扩展名文件不参与解析（CreateProcess 无法执行它）', () => {
    const s = sandbox();
    try {
      writeFileSync(join(s.dir, 'plain'), 'x');
      assert.equal(resolveWindowsCommand('plain', s.env), undefined);
    } finally {
      s.cleanup();
    }
  });

  it('已带扩展名的裸名先试原名（npx.cmd / node.exe）', () => {
    const s = sandbox();
    try {
      writeFileSync(join(s.dir, 'npx.cmd'), '@echo off\r\n');
      writeFileSync(join(s.dir, 'node.exe'), 'x');
      assert.equal(resolveWindowsCommand('npx.cmd', s.env)?.file, join(s.dir, 'npx.cmd'));
      assert.equal(resolveWindowsCommand('npx.cmd', s.env)?.viaCmd, true);
      assert.equal(resolveWindowsCommand('node.exe', s.env)?.file, join(s.dir, 'node.exe'));
      assert.equal(resolveWindowsCommand('node.exe', s.env)?.viaCmd, false);
    } finally {
      s.cleanup();
    }
  });

  it('找不到时返回 undefined', () => {
    const s = sandbox();
    try {
      assert.equal(resolveWindowsCommand('nope', s.env), undefined);
    } finally {
      s.cleanup();
    }
  });

  it('显式路径：无扩展名时补 PATHEXT；带扩展名认本体', () => {
    const s = sandbox();
    try {
      writeFileSync(join(s.dir, 'only.cmd'), '@echo off\r\n');
      assert.equal(resolveWindowsCommand(join(s.dir, 'only'), s.env)?.file, join(s.dir, 'only.cmd'));
      assert.equal(resolveWindowsCommand(join(s.dir, 'only.cmd'), s.env)?.viaCmd, true);
      assert.equal(resolveWindowsCommand(join(s.dir, 'missing'), s.env), undefined);
    } finally {
      s.cleanup();
    }
  });
});

describe('resolveWindowsCommand（真实环境）', { skip: process.platform === 'win32' ? false : '只对 Windows 有意义' }, () => {
  it('裸 npx 解析到 npx.cmd —— 本次报修的 bug', () => {
    const resolved = resolveWindowsCommand('npx');
    assert.ok(resolved, 'npx 必须能解析到（node 安装目录在 PATH 上）');
    assert.equal(resolved.viaCmd, true);
    assert.match(resolved.file, /npx\.cmd$/i);
  });
});

describe('经 cmd.exe 启动 .cmd 启动器跑通 MCP 握手', { skip: process.platform === 'win32' ? false : '只对 Windows 有意义' }, () => {
  it('fixture 的 .cmd 包装器能连上并列出工具', { timeout: 30_000 }, async () => {
    const { fileURLToPath } = await import('node:url');
    const fixture = fileURLToPath(new URL('./fixtures/minimal-server.mjs', import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), 'sph-cmd-e2e-'));
    const hub = new McpHub(testHostFacts());
    try {
      // 启动器刻意不带扩展名的裸调用 + 带引号的路径参数，把 cmd 转义层也一起压到。
      const launcher = join(dir, 'launcher.cmd');
      writeFileSync(launcher, `@echo off\r\nnode "${fixture}"\r\n`, 'utf8');

      await hub.reload([{ name: 'cmdfix', command: launcher }]);
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const server = hub.listServers().find((s) => s.name === 'cmdfix');
        if (server?.connected) {
          assert.equal(server.tools.some((tool) => tool.name === 'ping'), true);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.fail(`20s 内没有连上：${JSON.stringify(hub.listServers().map((s) => s.problem ?? s.target))}`);
    } finally {
      hub.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('stopStdioChild', { skip: process.platform === 'win32' ? false : '只对 Windows 有意义' }, () => {
  it('cmd.exe /c 的孙进程一起退出，管道不再占着事件循环', { timeout: 15_000 }, async () => {
    const { spawn } = await import('node:child_process');
    const dir = mkdtempSync(join(tmpdir(), 'sph-tree-kill-'));
    const pidFile = join(dir, 'pid');
    const js = join(dir, 'hang.js');
    writeFileSync(js, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);\n`);
    const cmd = join(dir, 'hang.cmd');
    writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${js}"\r\n`);
    const root = process.env.SystemRoot ?? 'C:\\Windows';
    const child = spawn(join(root, 'System32', 'cmd.exe'), ['/d', '/s', '/c', cmd], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.on('error', () => {});
    child.stdin?.on('error', () => {});
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});
    try {
      const deadline = Date.now() + 5_000;
      while (!existsSync(pidFile)) {
        if (child.exitCode !== null) throw new Error(`cmd exited early (${child.exitCode})`);
        if (Date.now() > deadline) throw new Error('grandchild did not start');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const grand = Number(readFileSync(pidFile, 'utf8'));
      stopStdioChild(child);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('cmd did not exit')), 5_000);
        if (child.exitCode !== null) {
          clearTimeout(timer);
          resolve();
          return;
        }
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      const gone = Date.now() + 3_000;
      while (pidAlive(grand)) {
        if (Date.now() > gone) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(pidAlive(grand), false, '孙进程应被 taskkill /T 关掉');
    } finally {
      try {
        child.kill();
      } catch {
        // 已经退出
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
