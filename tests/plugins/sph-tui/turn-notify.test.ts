import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runTui, type TuiDeps } from '@/plugins/sph-tui/interactive-mode.js';
import type { Terminal } from '@/tui/terminal/terminal.js';
import { TuiAltScreen } from '@/tui/screen/tui-alt-screen.js';
import type { RunTurnOptions } from '@/agent/driver.js';
import type { NotifySetting } from '@/config/primitives.js';
import { createPermissionRuntime } from '@/permission/runtime.js';
import type { ProviderDeclaration } from '@/config/registry.js';
import { EMPTY_PLUGIN_SERVICES } from '@/plugins/types.js';
import { JobBoard } from '@/plugins/sph-schedule/jobs.js';
import { EMPTY_TODO } from '@/plugins/services.js';
import { JsonlSession } from '@/plugins/sph-session/store.js';
import { setCapabilities } from '@/tui/terminal/terminal-image.js';
import { renderHelpReport } from '@/plugins/sph-tui/commands/reports.js';
import { COMMANDS, COMMAND_ALIASES } from '@/plugins/sph-tui/commands/index.js';
import { APP_KEYBINDINGS } from '@/plugins/sph-tui/input/app-keybindings.js';

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const settle = (ms = 120): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class FakeTerminal implements Terminal {
  private input?: (data: string) => void;
  readonly written: string[] = [];
  columns = 90;
  rows = 26;
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
  send(data: string): void {
    this.input?.(data);
  }
  screen(): string {
    return this.written.join('');
  }
}

/**
 * 提醒的字节。
 *
 * `auto` 写成「BEL 紧跟桌面通知 OSC」，`bell` 就是一记单独的 BEL。其余 BEL 是 OSC 8 /
 * OSC 11 这类排版序列的收尾（进屏那串里就有），那不是提醒——按 chunk 逐个认，别按子串搜全屏。
 */
function notificationChunks(terminal: FakeTerminal): string[] {
  return terminal.written.filter((chunk) => chunk === '\x07' || /\x07\x1b\](9|777|99);/.test(chunk));
}

function tuiDeps(terminal: Terminal, root: string, extra: Partial<TuiDeps> = {}): TuiDeps {
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
    mcp: () => undefined,
    reloadMcp: async () => ({ warnings: [], added: [], removed: [], restarted: [] }),
    permission: createPermissionRuntime({
      workspaceRoot: root,
      userRules: { allow: [], ask: [], deny: [] },
      userRulesDir: root,
      home: root,
      sandboxMode: 'off',
      sandboxAutoAllow: false,
      trusted: true,
    }),
    pluginReport: () => ({ plugins: [], failures: [], shadowed: [] }),
    pluginServices: EMPTY_PLUGIN_SERVICES,
    todos: EMPTY_TODO,
    jobs: new JobBoard(),
    approvalMode: 'ask',
    model: 'test-model',
    makeClient: () => ({ complete: async () => ({ text: '', finishReason: 'stop' }) }),
    makeAuxClient: () => undefined,
    terminal,
    ...extra,
  };
}

/** 一轮就返回的空驱动：只验收尾行为，不碰网络。 */
const idleTurn = async (): Promise<void> => {};

/** 卡到被中断才抛的驱动：演 Esc 中断那一条收尾。 */
const hangingTurn = (options: RunTurnOptions): Promise<void> =>
  new Promise((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });

/**
 * 起一次会话、按 `body` 里的手势跑、**退出之后再交回结果**。
 *
 * 退出放在 finally：断言写在 body 里抛错时 runTui 不会退，recap 的轮询定时器会把测试进程
 * 一直吊住——那时看到的是「用例挂起」而不是「用例失败」，最难查。
 */
async function session(
  options: {
    root: string;
    notify?: NotifySetting;
    afterSeconds?: number;
    /** 'out' = 先进屏再把焦点交还给别的窗口（1004 上报 `\x1b[O`），闸门默认按失焦必响。 */
    focus?: 'in' | 'out';
    driver?: (options: RunTurnOptions) => Promise<void>;
    ui?: TuiDeps['ui'];
    terminal?: FakeTerminal;
    clipboard?: TuiDeps['clipboard'];
  },
  body: (terminal: FakeTerminal) => Promise<void>,
): Promise<{ chunks: string[]; screen: string; config: string }> {
  // 注入 ui 时必须共用同一块终端：按键要送进 ui 自己的输入流，写出的帧也要在同一处收。
  const terminal = options.terminal ?? new FakeTerminal();
  const running = runTui(
    tuiDeps(terminal, options.root, {
      notify: options.notify,
      notifyAfterSeconds: options.afterSeconds,
      driver: options.driver ?? idleTurn,
      ui: options.ui,
      clipboard: options.clipboard,
    }),
  );
  await settle(320);
  if (options.focus === 'out') terminal.send('\x1b[O');
  await settle(60);
  try {
    await body(terminal);
  } finally {
    terminal.send('\x03');
    await settle(80);
    terminal.send('\x04');
    await running;
  }
  const configPath = join(options.root, 'config.toml');
  return {
    chunks: notificationChunks(terminal),
    screen: terminal.screen(),
    config: existsSync(configPath) ? readFileSync(configPath, 'utf8') : '',
  };
}

/** 发一句话并等收尾。命令与回车分两次送：整串带 `\r` 会走编辑器的插入分支，不等于提交。 */
async function sendPrompt(terminal: FakeTerminal, text: string): Promise<void> {
  terminal.send(text);
  await settle(80);
  terminal.send('\r');
  await settle(260);
}

describe('轮次收尾的完成提醒', () => {
  it('失焦时跑完一轮：响铃 + OSC 9，正文带上耗时', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-notify-turn-'));
    setCapabilities({ hyperlinks: false, notifications: 'osc9' });
    try {
      const result = await session({ root, focus: 'out' }, (terminal) => sendPrompt(terminal, 'hello there'));
      assert.equal(result.chunks.length, 1, '一轮只提醒一次');
      const [chunk] = result.chunks;
      assert.ok(chunk !== undefined);
      // 整条按原始字节断言：ANSI 剥离会把 `\x1b]9;…\x07` 整段当转义序列删掉，删完就没的可验。
      assert.match(chunk, /^\x07\x1b\]9;sph: Turn finished — \d+(\.\d)?s\x07$/, '先响铃，再写标题 sph + 耗时');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('焦点还在、这一轮又没等够阈值：静默（转录里已有收尾痕迹）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-notify-focused-'));
    setCapabilities({ hyperlinks: false, notifications: 'osc9' });
    try {
      const result = await session({ root, focus: 'in', afterSeconds: 10 }, (terminal) => sendPrompt(terminal, 'hi'));
      assert.deepEqual(result.chunks, [], '盯着屏幕的短轮次不响');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('阈值填 0 = 跑完就响，与焦点无关', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-notify-now-'));
    setCapabilities({ hyperlinks: false, notifications: 'osc9' });
    try {
      const result = await session({ root, focus: 'in', afterSeconds: 0 }, (terminal) => sendPrompt(terminal, 'hi'));
      assert.equal(result.chunks.length, 1, '焦点在也响');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('notify = off 时一个提醒字节都不写', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-notify-off-'));
    setCapabilities({ hyperlinks: false, notifications: 'osc9' });
    try {
      // 失焦是本组的默认前提：不满足它，off 这条用例就会「因为别的原因」而通过。
      const result = await session({ root, notify: 'off', focus: 'out' }, (terminal) => sendPrompt(terminal, 'hello'));
      assert.deepEqual(result.chunks, [], '收尾既不响铃也不写 OSC 9');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('探测不到桌面通道：auto 退化成只剩响铃', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-notify-bell-'));
    setCapabilities({ hyperlinks: false, notifications: 'none' });
    try {
      const result = await session({ root, focus: 'out' }, (terminal) => sendPrompt(terminal, 'hello'));
      assert.deepEqual(result.chunks, ['\x07'], '只有一记响铃');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('用户 Esc 中断不提醒：按得下这个键，人就在跟前', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-notify-abort-'));
    setCapabilities({ hyperlinks: false, notifications: 'osc9' });
    try {
      const result = await session({ root, focus: 'out', driver: hangingTurn }, async (terminal) => {
        terminal.send('slow down');
        await settle(80);
        terminal.send('\r');
        await settle(200);
        terminal.send('\x1b');
        await settle(240);
      });
      assert.deepEqual(result.chunks, [], '中断收尾静默');
      assert.match(result.screen.replace(ANSI, ''), /Interrupted|Cancelled/, '转录里仍给了打断反馈');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('/notify 与 /help', () => {
  it('/notify off 落到 [ui] 表，之后那一轮不再响', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-notify-cmd-'));
    setCapabilities({ hyperlinks: false, notifications: 'osc9' });
    writeFileSync(join(root, 'config.toml'), 'provider = "test"\nmodel = "test-model"\n', 'utf8');
    try {
      const result = await session({ root, focus: 'out' }, async (terminal) => {
        await sendPrompt(terminal, '/notify off');
        await sendPrompt(terminal, 'still working');
      });
      assert.match(result.screen.replace(ANSI, ''), /Notifications set to off/, '命令被分派并落了地');
      assert.match(result.config, /\[ui\][\s\S]*?"notify" = "off"/, '写进表体而不是顶层');
      assert.equal(result.chunks.length, 0, '改档之后的轮次静默');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('/notify 无参打开选择器，顶上如实写着这台终端的通道', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-notify-menu-'));
    setCapabilities({ hyperlinks: false, notifications: 'osc9' });
    try {
      const result = await session({ root }, (terminal) => sendPrompt(terminal, '/notify'));
      const bare = result.screen.replace(ANSI, '');
      assert.match(bare, /─ Notifications/, '选择器开出来了');
      assert.match(bare, /desktop channel: osc9/, '探测结果如实呈现');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('/help 的键位表带上 app.copy（注册表驱动，不用另写文案）', async () => {
    // 键位段在报告里排在命令表之后，弹窗视口未必滚得到——那一段的自动跟随由纯函数验，
    // 这里只验「命令确实开出了报告弹窗」这一条链路。
    const report = renderHelpReport({
      commands: COMMANDS,
      aliases: COMMAND_ALIASES,
      keybindings: Object.values(APP_KEYBINDINGS),
    });
    assert.match(report, /### Keys · selection/, '键位段按 when 分组，新语境自成一段');
    assert.match(report, /`Ctrl\+Shift\+C` — copy the selection to the system clipboard/, 'app.copy 自动进了表');
    assert.match(report, /\/notify/, '命令表带上 /notify');

    const root = mkdtempSync(join(tmpdir(), 'sph-notify-help-'));
    try {
      const result = await session({ root }, (terminal) => sendPrompt(terminal, '/help'));
      assert.match(result.screen.replace(ANSI, ''), /─ Commands/, '帮助弹窗开出来了');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('键盘复制只在有选区时接管', () => {
  /** Ctrl+Shift+C 的 CSI-u 编码：码点 99，修饰位 shift(1)+ctrl(4)，加基值 1 → 6。 */
  const CTRL_SHIFT_C = '\x1b[99;6u';

  /**
   * 在**已绘出的那一帧**里找一行文字并按住拖动。
   *
   * 顶栏是 dock 合成上去的，`ui.render()` 的布局行里看不到它的文字，所以坐标只能从终端
   * 收到的差分帧里读（`\x1b[行;1H\x1b[49m\x1b[2K<内容>`，每行一条）。
   */
  const ROW_BODY = /\x1b\[(\d+);1H\x1b\[49m\x1b\[2K([\s\S]*?)(?=\x1b\[\d+;1H\x1b\[49m\x1b\[2K|$)/g;

  function locate(terminal: FakeTerminal, token: string): { row: number; col: number } {
    let found: { row: number; col: number } | undefined;
    for (const match of terminal.screen().matchAll(ROW_BODY)) {
      const col = match[2]!.replace(ANSI, '').indexOf(token);
      if (col >= 0) found = { row: Number(match[1]) - 1, col };
    }
    assert.ok(found !== undefined, `当前帧里应能看到 ${token}`);
    return found;
  }

  async function dragOver(terminal: FakeTerminal, token: string): Promise<void> {
    const { row, col } = locate(terminal, token);
    terminal.send(`\x1b[<0;${col + 1};${row + 1}M`);
    terminal.send(`\x1b[<32;${col + token.length};${row + 1}M`);
    terminal.send(`\x1b[<0;${col + token.length};${row + 1}m`);
    await settle(80);
  }

  it('没有选区时不拦，有选区才复制', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-copy-key-'));
    const copied: string[] = [];
    const terminal = new FakeTerminal();
    const ui = new TuiAltScreen(terminal, false, undefined, {
      copySelection: async (text) => {
        copied.push(text);
        return 'native';
      },
    });
    ui.start();
    try {
      await session({ root, ui, terminal }, async (app) => {
        ui.renderNow(true);
        assert.equal(ui.hasTextSelection(), false, '刚进屏没有选区');
        app.send(CTRL_SHIFT_C);
        await settle(80);
        assert.equal(copied.length, 0, '无选区：按键没被接管，也没有复制');

        await dragOver(app, 'interrupt');
        assert.equal(ui.hasTextSelection(), true, '拖动之后有选区');
        app.send(CTRL_SHIFT_C);
        await settle(120);
        assert.equal(copied.length, 1, '有选区：复制发生');
        assert.match(copied[0]!, /interrupt/, '复制的是划到的那段');
        assert.equal(copied[0]!.endsWith(' '), false, '行尾填充空格没跟着进剪贴板');
      });
    } finally {
      ui.stop({ preserveScreen: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('/copy 整段复制助手回复', () => {
  /** 让「一轮」往会话里落一条有正文的助手回复，供 /copy 按序号取。 */
  const reportingTurn = async (options: RunTurnOptions): Promise<void> => {
    options.session.appendMessage({ role: 'assistant', content: 'LATEST REPORT' });
  };

  it('无参取最后一条；数到界外时如实说只有几条', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-copy-cmd-'));
    const copied: string[] = [];
    try {
      const result = await session(
        {
          root,
          driver: reportingTurn,
          clipboard: async (text) => {
            copied.push(text);
            return 'native';
          },
        },
        async (app) => {
          await sendPrompt(app, 'do the work');
          await sendPrompt(app, '/copy');
          await sendPrompt(app, '/copy 2');
        },
      );
      const bare = result.screen.replace(ANSI, '');
      assert.deepEqual(copied, ['LATEST REPORT'], '复制的是会话里的原文，只此一条');
      assert.match(bare, /Copied the last assistant reply \(1 line\)/, '反馈说清了复制了什么');
      assert.match(bare, /Only 1 assistant reply to copy/, '数到界外不谎称成功');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
