import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  clipboardTools,
  copyToClipboard,
  osc52Sequence,
  windowsClipboardArgs,
  type RunTool,
} from '@/plugins/sph-tui/clipboard.js';
import {
  NOTIFY_SETTINGS,
} from '@/config/primitives.js';
import { NOTIFY_HINTS, formatElapsed, notificationBytes, type CompletionNotice } from '@/plugins/sph-tui/notify.js';
import { detectNotificationChannelFromEnvironment } from '@/tui/terminal/terminal-image.js';
import { desktopNotifySequence, sanitizeNotificationText } from '@/tui/terminal/notifications.js';

interface FakeRun extends RunTool {
  calls: string[];
  inputs: (string | undefined)[];
}

/** 按命令名给退出码的假 spawn：null 表示「这个工具在本机根本起不来」。 */
function fakeRun(outcomes: Record<string, number | null>): FakeRun {
  const run: FakeRun = (command, _args, input) => {
    run.calls.push(command);
    run.inputs.push(input);
    return Promise.resolve(outcomes[command] ?? null);
  };
  run.calls = [];
  run.inputs = [];
  return run;
}

describe('剪贴板通路选择', () => {
  it('Windows 用 powershell Set-Clipboard，文本以 base64 进 -EncodedCommand', async () => {
    const run = fakeRun({ 'powershell.exe': 0 });
    const text = '他说 "引号" 与 `反引号` 都在\n第二行';
    assert.equal(await copyToClipboard(text, { platform: 'win32', run }), 'native');
    assert.deepEqual(run.calls, ['powershell.exe']);
    // 不走 shell：没有 /C，文本也不在参数里，只以编码后的脚本形式存在。
    const script = Buffer.from(windowsClipboardArgs(text)[3]!, 'base64').toString('utf16le');
    assert.match(script, /Set-Clipboard/);
    const payload = /FromBase64String\('([^']+)'\)/.exec(script)?.[1] ?? '';
    assert.equal(Buffer.from(payload, 'base64').toString('utf8'), text, '引号/换行/中文原样往返');
  });

  it('Linux 依次探测 wl-copy → xclip → xsel，前两个起不来就用第三个', async () => {
    const run = fakeRun({ 'wl-copy': null, xclip: null, xsel: 0 });
    assert.equal(await copyToClipboard('text', { platform: 'linux', run }), 'native');
    assert.deepEqual(run.calls, ['wl-copy', 'xclip', 'xsel']);
    assert.equal(run.inputs[2], 'text');
  });

  it('原生工具全不可用时退回 OSC 52，并如实标成 osc52 而不是成功', async () => {
    const written: string[] = [];
    const run = fakeRun({ 'pbcopy': null });
    const result = await copyToClipboard('hello', {
      platform: 'darwin',
      run,
      writeOsc52: (sequence) => written.push(sequence),
    });
    assert.equal(result, 'osc52');
    assert.deepEqual(written, [osc52Sequence('hello')]);
  });

  it('没有 OSC 52 可写时返回 failed——绝不报「已复制」', async () => {
    const result = await copyToClipboard('hello', { platform: 'darwin', run: fakeRun({ pbcopy: 1 }) });
    assert.equal(result, 'failed');
  });

  it('工具存在但退出码非零算没成，继续往下试', async () => {
    const run = fakeRun({ 'wl-copy': 1, xclip: 0 });
    assert.equal(await copyToClipboard('hello', { platform: 'linux', run }), 'native');
    assert.deepEqual(run.calls, ['wl-copy', 'xclip']);
  });

  it('OSC 52 的载荷按 UTF-8 base64 编码，非 ASCII 不靠终端代码页', () => {
    assert.equal(osc52Sequence('中'), `\x1b]52;c;${Buffer.from('中', 'utf8').toString('base64')}\x07`);
  });

  it('每个平台的候选表都只含命令与参数数组，没有 shell 字符串', () => {
    for (const tool of clipboardTools('linux', 'x; rm -rf /')) {
      assert.equal(tool.args.some((arg) => arg.includes(';')), false);
      assert.equal(tool.command !== '', true);
    }
  });
});

describe('桌面通知通道探测', () => {
  it('Windows Terminal / iTerm2 / WezTerm / Ghostty 走 OSC 9', () => {
    assert.equal(detectNotificationChannelFromEnvironment({ WT_SESSION: 'x' }), 'osc9');
    assert.equal(detectNotificationChannelFromEnvironment({ ITERM_SESSION_ID: 'x' }), 'osc9');
    assert.equal(detectNotificationChannelFromEnvironment({ TERM_PROGRAM: 'iTerm.app' }), 'osc9');
    assert.equal(detectNotificationChannelFromEnvironment({ WEZTERM_PANE: '1' }), 'osc9');
    assert.equal(detectNotificationChannelFromEnvironment({ GHOSTTY_RESOURCES_DIR: '/x' }), 'osc9');
  });

  it('kitty 走自己的 OSC 99，urxvt 走 OSC 777', () => {
    assert.equal(detectNotificationChannelFromEnvironment({ KITTY_WINDOW_ID: '1' }), 'osc99');
    assert.equal(detectNotificationChannelFromEnvironment({ TERM: 'rxvt-unicode-256color' }), 'osc777');
  });

  it(' multiplexer 与不认通知的终端算 none：转发不了就别写', () => {
    assert.equal(detectNotificationChannelFromEnvironment({ TMUX: '1', WT_SESSION: 'x' }), 'none');
    assert.equal(detectNotificationChannelFromEnvironment({ TERM: 'screen' }), 'none');
    assert.equal(detectNotificationChannelFromEnvironment({ TERM_PROGRAM: 'Apple_Terminal' }), 'none');
    assert.equal(detectNotificationChannelFromEnvironment({ TERM_PROGRAM: 'vscode' }), 'none');
    assert.equal(detectNotificationChannelFromEnvironment({}), 'none');
  });
});

describe('通知闸门', () => {
  /** 默认演「失焦 + 等够了」这条最常见的组合，用例只改自己关心的那一维。 */
  const notice = (over: Partial<CompletionNotice> = {}): CompletionNotice => ({
    setting: 'auto',
    channel: 'osc9',
    focused: false,
    elapsedMs: 30_000,
    afterMs: 10_000,
    title: 'sph',
    body: 'Turn finished',
    ...over,
  });

  it('off 一个字节都不写，哪怕失焦且等够了', () => {
    assert.equal(notificationBytes(notice({ setting: 'off' })), '');
  });

  it('失焦必响：阈值那一维根本不参与', () => {
    assert.match(notificationBytes(notice({ focused: false, elapsedMs: 0, afterMs: 600_000 })), /^\x07\x1b\]9;/);
  });

  it('焦点还在且没等够：静默——盯着屏幕时转录里本来就有收尾痕迹', () => {
    assert.equal(notificationBytes(notice({ focused: true, elapsedMs: 9_999 })), '');
    assert.match(notificationBytes(notice({ focused: true, elapsedMs: 10_000 })), /^\x07/, '刚好到阈值就算够');
  });

  it('阈值填 0 退化成「跑完就响」，与焦点无关', () => {
    assert.match(notificationBytes(notice({ focused: true, elapsedMs: 0, afterMs: 0 })), /^\x07\x1b\]9;/);
  });

  it('auto 是响铃 + 桌面通知；探测不到通道时只剩响铃', () => {
    const auto = notificationBytes(notice());
    assert.ok(auto.startsWith('\x07'), '先响铃');
    assert.match(auto, /^\x07\x1b\]9;/, '再写 OSC 9');
    assert.equal(notificationBytes(notice({ channel: 'none' })), '\x07');
  });

  it('bell 只响铃，desktop 只写通知（无通道就静默）', () => {
    assert.equal(notificationBytes(notice({ setting: 'bell' })), '\x07');
    assert.match(notificationBytes(notice({ setting: 'desktop', channel: 'osc777' })), /^\x1b\]777;notify;sph;Turn finished\x1b\\$/);
    assert.equal(notificationBytes(notice({ setting: 'desktop', channel: 'none' })), '');
  });

  it('kitty 的 OSC 99 分三段：标题、正文、结束', () => {
    const sequence = desktopNotifySequence('osc99', 'sph', 'Turn finished');
    assert.deepEqual(
      sequence.split('\x1b]').filter((part) => part !== ''),
      [
        '99;i=sph:d=0;sph\x1b\\',
        '99;i=sph:d=1;Turn finished\x1b\\',
        '99;i=sph:d=2;\x1b\\',
      ],
    );
  });

  it('正文里的转义序列与响铃被清掉：错误信息不许往终端塞指令', () => {
    const dirty = 'a\x1b]0;pwned\x07b\n\x1b[31mc';
    // ESC / BEL / 换行都没了，剩下的只是无害的字面字符；换行折成空格（通知正文是一行）。
    assert.equal(sanitizeNotificationText(dirty), 'a]0;pwnedb [31mc');
    const sequence = desktopNotifySequence('osc9', 'sph', dirty);
    assert.equal(sequence.startsWith('\x1b]9;'), true);
    assert.equal(sequence.slice('\x1b]9;'.length, -1).includes('\x1b'), false, '载荷里没有第二个 ESC');
    assert.equal(sequence.endsWith('\x07'), true);
  });

  it('四种档位都有说明文案（/notify 菜单与配置模板共用）', () => {
    for (const setting of NOTIFY_SETTINGS) assert.ok(NOTIFY_HINTS[setting].length > 0, setting);
  });

  it('耗时读数：十秒级带一位小数，分钟级换成 m/s', () => {
    assert.equal(formatElapsed(12_400), '12.4s');
    assert.equal(formatElapsed(75_000), '1m 15s');
    assert.equal(formatElapsed(0), '0.0s');
  });
});
