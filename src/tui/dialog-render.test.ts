import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { TuiAltScreen } from './core/tui-alt-screen.js';
import type { Terminal } from './core/terminal.js';
import { showMessageDialog } from './dialogs.js';
import { renderMcpReport, renderSkillsReport } from './reports.js';
import { runTui, type TuiDeps } from './interactive-mode.js';
import { McpHub } from '../mcp/hub.js';
import { JobBoard } from '../runtime/jobs.js';
import { TodoList } from '../runtime/todos.js';
import { JsonlSession } from '../session/store.js';

/**
 * 只写不读的假终端：记录写入，让用例能在渲染结果里搜文本。
 *
 * 用真实渲染链（TuiAltScreen）而不是把 showOverlay 桩掉：这一层正是「弹窗到底有没有显示」
 * 的所在，桩掉等于把要验证的东西验证掉。`renderNow` 是同步的，不必等渲染定时器。
 */
class FakeTerminal implements Terminal {
  private input?: (data: string) => void;
  private readonly written: string[] = [];
  columns = 100;
  rows = 30;
  kittyProtocolActive = false;

  start(onInput: (data: string) => void): void {
    this.input = onInput;
  }

  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.written.push(data);
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}

  /** 累积输出（含转义序列；用例只做子串搜索）。 */
  screen(): string {
    return this.written.join('');
  }

  send(data: string): void {
    this.input?.(data);
  }
}

/** 驱动一次：开屏、渲染、断言、Esc 关闭。返回渲染出的屏幕文本。 */
async function renderInDialog(title: string, text: string): Promise<string> {
  const terminal = new FakeTerminal();
  const ui = new TuiAltScreen(terminal, false, '/ws');
  ui.start();
  try {
    const closed = showMessageDialog(ui, { title, text });
    ui.renderNow(true);
    const screen = terminal.screen();
    terminal.send('\x1b');
    await closed;
    return screen;
  } finally {
    ui.stop({ preserveScreen: true });
  }
}

describe('上报弹窗的真实渲染', () => {
  it('技能上报的标题与条目真的出现在屏幕上', async () => {
    const text = renderSkillsReport({
      catalog: [{ name: 'pdf', description: 'Fill PDF forms', path: '/ws/.sph/skills/pdf/SKILL.md' }],
      warnings: [],
      roots: ['/ws/.sph/skills'],
    });
    const screen = await renderInDialog('Skills', text);
    assert.match(screen, /Skills/);
    assert.match(screen, /pdf/);
    assert.match(screen, /Fill PDF forms/);
  });

  it('MCP 上报在连不上时也把 server 名字显示出来', async () => {
    const text = renderMcpReport({
      servers: [
        {
          name: 'broken',
          transport: 'stdio',
          supported: true,
          enabled: true,
          connected: false,
          target: 'npx -y broken-mcp',
          problem: 'failed to start: spawn npx ENOENT',
          origin: { label: '~/.sph/config.toml', path: '/home/u/.sph/config.toml', editable: true },
          tools: [],
        },
      ],
      warnings: ['broken: spawn npx ENOENT'],
    });
    const screen = await renderInDialog('MCP servers', text);
    assert.match(screen, /MCP servers/);
    assert.match(screen, /broken/);
    assert.match(screen, /not connected/);
  });

  it('Esc 能关掉弹窗（Promise 会 resolve，不会挂住界面）', async () => {
    const terminal = new FakeTerminal();
    const ui = new TuiAltScreen(terminal, false, '/ws');
    ui.start();
    try {
      const closed = showMessageDialog(ui, { title: 'Skills', text: '## Skills (0)' });
      ui.renderNow(true);
      assert.equal(ui.hasOverlay(), true);
      terminal.send('\x1b');
      await closed;
      assert.equal(ui.hasOverlay(), false);
    } finally {
      ui.stop({ preserveScreen: true });
    }
  });
});

/** 让 TUI 把一次输入处理完（渲染是同步的，只需让出事件循环）。 */
const settle = (ms = 80): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function tuiDeps(terminal: Terminal, root: string, mcp: McpHub): TuiDeps {
  return {
    workspaceRoot: root,
    sessionDir: root,
    configPath: join(root, 'config.toml'),
    authLabel: 'test',
    baseUrl: 'http://example.invalid/v1',
    contextWindow: 100_000,
    sandbox: {
      status: { mode: 'off', enforcement: 'none', platform: process.platform },
      tempDir: '',
      run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      dispose() {},
    },
    session: new JsonlSession(root, 'test'),
    mcp,
    reloadMcp: async () => ({ warnings: [], added: [], removed: [], restarted: [] }),
    refreshMcpPreferences: () => {},
    mcpPreferences: { disabledServers: [], enabledServers: [] },
    mcpSources: () => [],
    todos: new TodoList(),
    jobs: new JobBoard(),
    approvalMode: 'ask',
    model: 'test-model',
    api: 'chat-completions',
    makeClient: () => ({ complete: async () => ({ text: '', finishReason: 'stop' }) }),
    makeAuxClient: () => undefined,
    fetchModels: async () => [],
    terminal,
  };
}

/**
 * 从敲命令到弹窗上屏的整条链路：命令表注册 → 分派 → 取数 → 弹窗 → 渲染。
 *
 * 这里只断言**视口内必然可见**的文本，内容细节交给 reports.test.ts 的纯函数用例——
 * showMessageDialog 是滚动视口，长过一屏的内容不会进屏幕缓冲，拿折叠区下面的文字做断言
 * 只会得到一个和实现无关的假失败。真正要这一层验证的是：命令被注册并被分派到（漏加进
 * COMMANDS 会得到 "Unknown command"，漏一个 switch 分支则静默无反应，两者都不会让
 * 上报文本的单元测试失败）。
 *
 * 另外三条踩过的坑，写在这里免得以后重踩：
 * - 命令与回车必须**分两次**送：整串 `/skills\r` 会走编辑器的「插入文本」分支，`\r`
 *   变成正文而不是提交键。真实终端就是逐键到达的。
 * - 回车要等补全菜单先出来（斜杠补全会异步挂上），模拟真实按键节奏。
 * - 退出走 Esc 关弹窗 + Ctrl+D，不用 `/exit`：浮层打开时输入被浮层接走，而 Ctrl+D
 *   只在输入为空时生效。
 */
async function driveCommand(
  terminal: FakeTerminal,
  root: string,
  mcp: McpHub,
  overrides: Partial<TuiDeps>,
  command: string,
): Promise<string> {
  const running = runTui({ ...tuiDeps(terminal, root, mcp), ...overrides });
  await settle(300);
  terminal.send(command);
  await settle(300);
  terminal.send('\r');
  await settle(300);
  const screen = terminal.screen();
  terminal.send('\x1b');
  await settle();
  terminal.send('\x04');
  await running;
  return screen;
}

describe('斜杠命令打通到弹窗', () => {
  it('/skills 打开弹窗，且目录来自工作区扫描', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-cmd-skills-'));
    const terminal = new FakeTerminal();
    const mcp = new McpHub();
    try {
      // 名字按字母序排最前：列表可能长过一屏，只有排在最前的条目才一定在视口内。
      const dir = join(root, '.sph', 'skills', '000-widget');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), '---\nname: 000-widget\ndescription: Widget builder\n---\n', 'utf8');

      const screen = await driveCommand(terminal, root, mcp, {}, '/skills');
      assert.match(screen, /Skills \(\d+\)/, '弹窗里应当渲染出上报标题');
      assert.match(screen, /The model sees only the name and description/, '渲染的是有内容的分支而不是空分支');
      assert.match(screen, /Widget builder/, '工作区里的技能被扫到了');
      assert.equal(screen.includes('Unknown command'), false);
    } finally {
      mcp.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('/mcps 打开管理器，把连不上的 server 连原因一起显示出来', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-cmd-mcps-'));
    const terminal = new FakeTerminal();
    const mcp = new McpHub();
    try {
      await mcp.reload([{ name: 'broken', command: 'definitely-not-a-real-binary-xyz' }]);
      await mcp.whenReady();
      const screen = await driveCommand(terminal, root, mcp, {}, '/mcps');
      assert.match(screen, /MCP servers \(1\)/);
      assert.match(screen, /broken — not connected/);
      assert.match(screen, /Reload from disk/, '管理器动作要可见，而不是只读弹窗');
      assert.equal(screen.includes('Unknown command'), false);
    } finally {
      mcp.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
