import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { TuiAltScreen } from '../../src/tui/core/tui-alt-screen.js';
import type { Terminal } from '../../src/tui/core/terminal.js';
import { showMessageDialog, showSelectDialog } from '../../src/tui/dialogs.js';
import { PALETTE } from '../../src/tui/theme/palettes.js';
import { theme } from '../../src/tui/theme/theme.js';
import { renderMcpReport, renderSkillsReport } from '../../src/tui/reports.js';
import { runTui, type TuiDeps } from '../../src/tui/interactive-mode.js';
import type { ProviderDeclaration } from '../../src/config/registry.js';
import { McpHub } from '../../src/mcp/hub.js';
import { JobBoard } from '../../src/runtime/jobs.js';
import { TodoList } from '../../src/runtime/todos.js';
import { JsonlSession } from '../../src/session/store.js';

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
          lazy: false,
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

  it('帮助正文走主题白 #c6c6c6，不落到终端默认 #cccccc', async () => {
    const screen = await renderInDialog('Help', '- `/help` — List commands and key bindings');
    assert.equal(PALETTE.mdText, '#c6c6c6');
    const painted = theme.fg('mdText', 'x');
    const seq = painted.slice(0, painted.indexOf('x'));
    assert.ok(seq.length > 0, 'mdText 应产出前景色序列');
    assert.ok(screen.includes(seq), '弹窗正文应使用主题白，而不是终端默认前景');
    assert.doesNotMatch(screen, /\x1b\[38;2;204;204;204m/);
  });

  it('选择框正文走主题白，长文可滚而不是截成省略号', async () => {
    const terminal = new FakeTerminal();
    terminal.rows = 18;
    terminal.columns = 80;
    const ui = new TuiAltScreen(terminal, false, '/ws');
    ui.start();
    try {
      const rows = Array.from({ length: 40 }, (_, i) => `PLANROW-${String(i + 1).padStart(2, '0')}`);
      const pending = showSelectDialog(ui, {
        title: 'Plan',
        bodyText: rows.join('\n\n'),
        items: [
          { value: 'approve', label: 'Approve' },
          { value: 'revise', label: 'Keep planning' },
        ],
        maxVisible: 2,
        maxHeight: '80%',
      });
      ui.renderNow(true);
      const first = terminal.screen();
      const painted = theme.fg('mdText', 'x');
      const seq = painted.slice(0, painted.indexOf('x'));
      assert.ok(first.includes(seq), '计划正文应使用主题白 mdText');
      assert.match(first, /PLANROW-01/);
      assert.doesNotMatch(first, /PLANROW-40/);
      terminal.send('\x1b[F');
      ui.renderNow(true);
      assert.match(terminal.screen(), /PLANROW-40/);
      terminal.send('\x1b');
      await pending;
    } finally {
      ui.stop({ preserveScreen: true });
    }
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
  const provider: ProviderDeclaration = {
    name: 'test',
    baseUrl: 'https://example.invalid/v1',
    api: 'chat-completions',
    apiKey: '',
    headers: {},
    models: [{ id: 'test-model' }],
  };
  return {
    workspaceRoot: root,
    sessionDir: root,
    configPath: join(root, 'config.toml'),
    authLabel: 'test',
    providerName: provider.name,
    models: () => [provider],
    resolveModel: (model, providerName) => ({
      provider: providerName === undefined ? provider : { ...provider, name: providerName },
      id: model,
      api: provider.api,
    }),
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
    mcpPreferences: { disabledServers: [], enabledServers: [], lazyServers: [] },
    mcpSources: () => [],
    todos: new TodoList(),
    jobs: new JobBoard(),
    approvalMode: 'ask',
    model: 'test-model',
    makeClient: () => ({ complete: async () => ({ text: '', finishReason: 'stop' }) }),
    makeAuxClient: () => undefined,
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

  it('/resume 打开会话选择器并列出会话', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-cmd-resume-'));
    const terminal = new FakeTerminal();
    const mcp = new McpHub();
    try {
      // 选择器只列有对话的会话：没有 message 记录的文件会被 listSessions 跳过。
      writeFileSync(
        join(root, 'aaaaaaaa.jsonl'),
        `${JSON.stringify({ type: 'message', ts: new Date().toISOString(), id: 'e1', parentId: null, role: 'user', content: 'earlier work' })}\n`,
        'utf8',
      );

      const screen = await driveCommand(terminal, root, mcp, {}, '/resume');
      assert.match(screen, /Sessions/, '选择器标题');
      assert.match(screen, /aaaaaaaa/, '会话 id 进了列表');
      assert.equal(screen.includes('Unknown command'), false);
    } finally {
      mcp.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('/sessions 是 /resume 的别名，仍然可达', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-cmd-alias-'));
    const terminal = new FakeTerminal();
    const mcp = new McpHub();
    try {
      // 空目录下能走到「没有会话」这句，就说明别名解析到了 /resume；被当成未知命令时
      // 屏幕上会是 "Unknown command"，两者完全不同。
      const screen = await driveCommand(terminal, root, mcp, {}, '/sessions');
      assert.match(screen, /No sessions yet/);
      assert.equal(screen.includes('Unknown command'), false);
    } finally {
      mcp.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('/permission 打开审批模式选择器（命令名对齐 dsh）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-cmd-permission-'));
    const terminal = new FakeTerminal();
    const mcp = new McpHub();
    try {
      const screen = await driveCommand(terminal, root, mcp, {}, '/permission');
      assert.match(screen, /Approval mode/);
      assert.equal(screen.includes('Unknown command'), false);
    } finally {
      mcp.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('/compact 把历史压成检查点，并落一条 compaction 事件', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-cmd-compact-'));
    const terminal = new FakeTerminal();
    const mcp = new McpHub();
    try {
      // 摘要只在「保留窗口之外还有原始记录」时才会跑，所以要给足 8 条以上。
      // 用 JsonlSession 真写一遍而不是手搓 JSON：parentId 链条由 append 自己接，
      // 手写时链条一断 readMessages 就只剩尾巴，断言会退化成「测了个空」。
      const seed = new JsonlSession(root, 'test');
      for (let i = 1; i <= 12; i++) {
        seed.appendMessage({ role: 'user', content: `turn ${i}` });
        seed.appendMessage({ role: 'assistant', content: `a${i}` });
      }

      const screen = await driveCommand(
        terminal,
        root,
        mcp,
        {
          makeClient: () => ({
            complete: async () => ({ text: '## Goal and Acceptance Criteria\n- done', finishReason: 'stop' }),
          }),
        },
        '/compact',
      );

      assert.match(screen, /Compacted \d+ messages into a checkpoint/);
      assert.equal(screen.includes('Unknown command'), false);
      // 只写事件、不维护内存态：下一轮由 loadCompaction 读回来，所以落盘是唯一要验证的。
      assert.match(readFileSync(join(root, 'test.jsonl'), 'utf8'), /"kind":"compaction"/);
    } finally {
      mcp.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
