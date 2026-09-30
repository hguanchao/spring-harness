import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { TuiAltScreen } from '@/tui/screen/tui-alt-screen.js';
import { paintScreenDiff } from '@/tui/screen/tui-alt-screen.js';
import type { Terminal } from '@/tui/terminal/terminal.js';
import { showMessageDialog, showSelectDialog, commandPanelOptions } from '@/plugins/sph-tui/dialogs.js';
import { visibleWidth } from '@/tui/text/utils.js';
import { PALETTE } from '@/plugins/sph-tui/theme/palettes.js';
import { theme } from '@/plugins/sph-tui/theme/theme.js';
import { renderMcpReport, renderSkillsReport, renderHelpReport } from '@/plugins/sph-tui/commands/reports.js';
import { COMMANDS, COMMAND_ALIASES } from '@/plugins/sph-tui/commands/index.js';
import { APP_KEYBINDINGS } from '@/plugins/sph-tui/input/app-keybindings.js';
import { runTui, type TuiDeps } from '@/plugins/sph-tui/interactive-mode.js';
import { createPermissionRuntime } from '@/permission/runtime.js';
import type { ProviderDeclaration } from '@/config/registry.js';
import { PluginHost } from '@/plugins/host.js';
import { discoverPlugins } from '@/plugins/loader.js';
import { McpHub } from '@/plugins/sph-mcp/hub.js';
import { testHostFacts } from '../host-fixture.js';
import type { McpService } from '@/plugins/services.js';
import { EMPTY_PLUGIN_SERVICES } from '@/plugins/types.js';
import { JobBoard } from '@/plugins/sph-schedule/jobs.js';
import { EMPTY_TODO } from '@/plugins/services.js';
import type { SkillRoot } from '@/plugins/sph-skills/scan.js';
import { JsonlSession } from '@/plugins/sph-session/store.js';

/**
 * 只写不读的假终端：记录写入，让用例能在渲染结果里搜文本。
 *
 * 用真实渲染链（TuiAltScreen）而不是把 showOverlay 桩掉：这一层正是「弹窗到底有没有显示」
 * 的所在，桩掉等于把要验证的东西验证掉。`renderNow` 是同步的，不必等渲染定时器。
 */
/** 测试里的技能根：`level` 决定组标题写 User 还是 Project。 */
function root(path: string, level: 'User' | 'Project' = 'User'): SkillRoot {
  return { path, level };
}

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
    const closed = showMessageDialog(ui, { title, text, termColumns: true });
    ui.renderNow(true);
    const screen = terminal.screen();
    terminal.send('\x1b');
    await closed;
    return screen;
  } finally {
    ui.stop({ preserveScreen: true });
  }
}

/** 某个主题色实际发出的前景序列；与 theme.fg 同源，免得在用例里手写色值。 */
function fgSeq(color: Parameters<typeof theme.fg>[0]): string {
  const painted = theme.fg(color, 'x');
  return painted.slice(0, painted.indexOf('x'));
}

describe('上报弹窗的真实渲染', () => {
  it('技能上报的标题与条目真的出现在屏幕上，条目排成词项列', async () => {
    const text = renderSkillsReport({
      catalog: [
        { name: 'pdf', description: 'Fill PDF forms', path: '/ws/.sph/skills/pdf/SKILL.md', root: '/ws/.sph/skills' },
        { name: 'sheet', description: 'Edit sheets', path: '/ws/.sph/skills/sheet/SKILL.md', root: '/ws/.sph/skills' },
      ],
      warnings: [],
      roots: [root('/ws/.sph/skills', 'Project')],
    });
    const screen = await renderInDialog('Skills', text);
    assert.match(screen, /Skills/);
    assert.match(screen, /Fill PDF forms/);
    const rows = screen.split(/\x1b\[\d+;\d+H/);
    const pdfRow = rows.find((row) => row.includes('pdf') && row.includes('Fill PDF forms'));
    assert.ok(pdfRow !== undefined, '名字与说明同一行');
    assert.ok(pdfRow.includes(fgSeq('mdCode')), '词项仍是蓝色行内码那一档');
    const sheetRow = rows.find((row) => row.includes('sheet') && row.includes('Edit sheets'));
    assert.ok(sheetRow !== undefined);
    const plainOf = (row: string): string => row.replace(/\x1b\[[0-9;?]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
    // 两条的说明起点必须同一格——那才是词项列存在的理由（两档颜色的规则由 markdown 用例守）。
    assert.equal(plainOf(sheetRow).indexOf('Edit'), plainOf(pdfRow).indexOf('Fill'), '说明列同一格起');
    assert.equal(screen.includes('pdf/SKILL.md'), false, '单一来源时不再逐条列路径');
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

  it('帮助弹窗盖在原有行上，左右的转录还在', async () => {
    const terminal = new FakeTerminal();
    const ui = new TuiAltScreen(terminal, false, '/ws');
    ui.addChild({
      invalidate() {},
      render: (width: number) => {
        const line = `Q${' '.repeat(Math.max(0, width - 2))}Q`;
        return Array.from({ length: 40 }, () => line);
      },
    });
    ui.start();
    try {
      const closed = showMessageDialog(ui, { title: 'Help', text: 'commands' });
      ui.renderNow(true);
      const screen = terminal.screen();
      assert.match(screen, /Help/);
      const rows = screen.split(/\x1b\[\d+;1H/);
      assert.ok(
        rows.some((row) => row.includes('Q') && row.includes('│')),
        '对话框所在行的左右两侧应仍是原来的转录',
      );
      terminal.send('\x1b');
      await closed;
    } finally {
      ui.stop({ preserveScreen: true });
    }
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

  it('对话框整行铺浮层面色，行内 SGR 之后要重申', async () => {
    const terminal = new FakeTerminal();
    const ui = new TuiAltScreen(terminal, false, '/ws');
    ui.start();
    try {
      const closed = showSelectDialog(ui, {
        title: 'Help',
        bodyText: '- `/help` — List commands and key bindings',
        items: [{ value: 'ok', label: 'Close' }],
        maxVisible: 1,
      });
      ui.renderNow(true);
      const screen = terminal.screen();
      const surface = theme.bgSeq('dialogBg');
      // 画布与浮层同色时，卡片会被读成「抠掉一块露出黑底」——所以每条框线行都要有面层底色，
      // 且行内 SGR（`0m` 全重置）之后要重申，否则整行后半截会掉回画布色。
      const boxRows = screen.split(/\x1b\[\d+;1H/).filter((row) => row.includes('│') || row.includes('╭'));
      assert.ok(boxRows.length >= 3, `应渲染出对话框框线行，实际 ${boxRows.length} 行`);
      for (const row of boxRows) {
        const count = row.split(surface).length - 1;
        assert.ok(count >= 2, `框线行应铺底并在 SGR 后重申，实际出现 ${count} 次: ${JSON.stringify(row.slice(0, 80))}`);
      }
      terminal.send('\x1b');
      await closed;
    } finally {
      ui.stop({ preserveScreen: true });
    }
  });
});

/**
 * 报告框的滚动边界。
 *
 * 守两条用户直接看得到、手测又容易漏的底线：滚到最后时最后一行必须真的在屏上；框里任何
 * 一行变宽都会把右边框顶开，观感正是「边框被折断」，所以整帧的框线行宽度必须一致。
 */
describe('报告框的滚动与边框', () => {
	/** 全量重绘会把每一行重写一遍，截下这一段就是当前帧（按行号顺序）。 */
	function captureFrame(terminal: FakeTerminal, ui: TuiAltScreen): string[] {
		const mark = terminal.screen().length;
		ui.renderNow(true);
		return terminal.screen().slice(mark).split(/\x1b\[\d+;1H\x1b\[49m\x1b\[2K/).slice(1);
	}

	/** 真报告：规则标题、长路径、`↑/↓`、`%%…%%` 都在里面，比手搓的内容更接近用户看到的。 */
	const helpText = renderHelpReport({
		commands: Object.values(COMMANDS),
		aliases: COMMAND_ALIASES,
		keybindings: Object.values(APP_KEYBINDINGS),
	});

	async function openReport(
		rows: number,
		columns: number,
	): Promise<{ terminal: FakeTerminal; ui: TuiAltScreen; closed: Promise<void> }> {
		const terminal = new FakeTerminal();
		terminal.rows = rows;
		terminal.columns = columns;
		const ui = new TuiAltScreen(terminal, false, '/ws');
		ui.start();
		const closed = showMessageDialog(ui, { title: 'Help', text: helpText, ...commandPanelOptions(ui) });
		return { terminal, ui, closed };
	}

	/** 框线行（含左右竖线、上边框、底边框）的宽度集合；多于一个值就是边框被顶开了。 */
	function boxRowWidths(frame: string[]): number[] {
		return frame
			.filter((row) => row.includes('│') || row.includes('╭') || row.includes('╰'))
			.map((row) => visibleWidth(row));
	}

	function bareOf(frame: string[]): string {
		return frame.map((row) => row.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
	}

	it('每一帧的框线行都等宽：内容不许把右边框顶开', async () => {
		const { terminal, ui, closed } = await openReport(30, 100);
		try {
			for (let step = 0; step < 10; step++) {
				const frame = captureFrame(terminal, ui);
				const widths = boxRowWidths(frame);
				assert.ok(widths.length > 0, '应渲染出框线');
				const distinct = new Set(widths);
				assert.equal(distinct.size, 1, `框线行宽度必须一致，实际 ${[...distinct].join(' / ')}：\n${bareOf(frame)}`);
				terminal.send('\x1b[6~');
			}
			terminal.send('\x1b');
			await closed;
		} finally {
			ui.stop({ preserveScreen: true });
		}
	});

	/** 从底边框的 `起点-终点/总数` 里取当前滚动位置；没有位置信息（装得下）就返回 undefined。 */
	function scrollInfo(frame: string[]): { start: number; end: number; total: number } | undefined {
		const match = /(\d+)-(\d+)\/(\d+)/.exec(bareOf(frame));
		if (match === null) return undefined;
		return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
	}

	/**
	 * 断言这一帧已经滚到末尾。
	 *
	 * 判据就是底边框的位置读数：终点 === 总数，意思是视口已经铺到最后一行内容上。
	 * 别用正文文案当哨兵——长行会折行（`starts after this turn` 这种片段根本不在一行里），
	 * 而 `Alt+Enter` 之类又在更上面的 Keys 段出现过，拿它当哨兵会假通过；矮终端上最后一段的
	 * 标题也未必落在视口里。
	 */
	function assertAtEnd(frame: string[], context = ''): void {
		const bare = bareOf(frame);
		const info = scrollInfo(frame);
		assert.ok(info !== undefined, `底边框该有滚动位置（内容装不下时才有）；${context}\n整帧是：\n${bare}`);
		assert.equal(info.end, info.total, `滚到底时终点应等于总数；${context}\n整帧是：\n${bare}`);
	}

	it('滚轮在框内也能滚到底', async () => {
		const { terminal, ui, closed } = await openReport(30, 100);
		try {
			const first = scrollInfo(captureFrame(terminal, ui));
			const trace: string[] = [`首帧 ${JSON.stringify(first)}`];
			// 框占 3..24 行、20..79 列，取一个框内的点。
			for (let step = 0; step < 120; step++) {
				terminal.send('\x1b[<65;51;16M');
				trace.push(JSON.stringify(scrollInfo(captureFrame(terminal, ui))));
			}
			const frame = captureFrame(terminal, ui);
			assertAtEnd(frame, `滚轮 每步读数：${trace.slice(0, 4).join(' → ')} … ${trace.slice(-3).join(' → ')}`);
			terminal.send('\x1b');
			await closed;
		} finally {
			ui.stop({ preserveScreen: true });
		}
	});

	it('滚到最后一屏时最后一行可见，且上下边框都还在', async () => {
		// 高度预算按终端行数算，矮终端最容易暴露「差几行」和底边框被裁。
		for (const [rows, columns] of [[30, 100], [24, 80], [20, 120], [14, 60], [40, 140]] as const) {
			const { terminal, ui, closed } = await openReport(rows, columns);
			try {
				// 先出一帧：视口尺寸由渲染时算出，没渲染过的话滚动上限还是 0，按什么键都不动。
				const first = scrollInfo(captureFrame(terminal, ui));
				const trace: string[] = [`首帧 ${JSON.stringify(first)}`];
				for (let step = 0; step < 40; step++) {
					terminal.send('\x1b[6~');
					trace.push(JSON.stringify(scrollInfo(captureFrame(terminal, ui))));
				}
				terminal.send('\x1b[F');
				const frame = captureFrame(terminal, ui);
				const bare = bareOf(frame);
				assertAtEnd(frame, `${rows}x${columns} 每步读数：${trace.slice(0, 6).join(' → ')} … ${trace.slice(-2).join(' → ')}`);
				assert.ok(frame.some((row) => row.includes('╰')), `${rows}x${columns}：底边框还在；整帧是：\n${bare}`);
				assert.ok(frame.some((row) => row.includes('╭')), `${rows}x${columns}：顶边框还在；整帧是：\n${bare}`);
				terminal.send('\x1b');
				await closed;
			} finally {
				ui.stop({ preserveScreen: true });
			}
		}
	});

	it('滚动走增量重绘时也不发滚动区指令（发出去就是把边框卷走）', async () => {
		const { terminal, ui, closed } = await openReport(30, 100);
		try {
			const before = captureFrame(terminal, ui); // 首帧全量
			const mark = terminal.screen().length;
			terminal.send('\x1b[<65;51;16M');
			ui.renderNow(); // 增量重绘：滚动条守卫管不到对话框，得由 hasOverlay 挡住
			const delta = terminal.screen().slice(mark);
			assert.equal(/\x1b\[\d+;\d+r/.test(delta), false, '增量重绘不许用终端滚动区挪像素');
			assert.equal(delta.includes('\x1b[1S'), false, '也不许整屏上滚');
			assert.ok(delta.length > 0, '滚过之后必须有行被重画，否则这条断言是空的');

			// 证明这条守卫是吃劲的：同样的两帧，不告诉它「有浮层」时，它判定成整段平移。
			const after = captureFrame(terminal, ui);
			const unguarded = paintScreenDiff({
				screen: after,
				previous: before,
				previousWidth: 100,
				previousHeight: 30,
				width: 100,
				height: 30,
			});
			assert.match(unguarded.buffer, /\x1b\[\d+;\d+r/, '对话框里滚动正文，本来是会被判成整段垂直平移的');
			terminal.send('\x1b');
			await closed;
		} finally {
			ui.stop({ preserveScreen: true });
		}
	});

	it('无空格的长路径被硬折行时也不越宽（技能根路径就是这么长的）', async () => {
		const text = renderSkillsReport({
			catalog: [
				{
					name: '000-widget',
					description: 'Widget builder',
					path: 'C:\\Users\\Chao\\AppData\\Local\\Temp\\sph-cmd-skills-G6McRV\\.sph\\skills\\000-widget\\SKILL.md',
					root: 'C:\\Users\\Chao\\AppData\\Local\\Temp\\sph-cmd-skills-G6McRV\\.sph\\skills',
				},
				{
					name: 'frontend-design',
					description: 'Guidance for distinctive visual design',
					path: 'C:\\Users\\Chao\\.agents\\skills\\frontend-design\\SKILL.md',
					root: 'C:\\Users\\Chao\\.agents\\skills',
				},
			],
			warnings: [],
			roots: [
				root('C:\\Users\\Chao\\.agents\\skills'),
				root('C:\\Users\\Chao\\AppData\\Local\\Temp\\sph-cmd-skills-G6McRV\\.sph\\skills', 'Project'),
			],
		});
		const terminal = new FakeTerminal();
		terminal.rows = 30;
		terminal.columns = 100;
		const ui = new TuiAltScreen(terminal, false, '/ws');
		ui.start();
		try {
			const closed = showMessageDialog(ui, { title: 'Skills', text, ...commandPanelOptions(ui) });
			for (let step = 0; step < 12; step++) {
				const frame = captureFrame(terminal, ui);
				const widths = boxRowWidths(frame);
				const distinct = new Set(widths);
				assert.equal(distinct.size, 1, `框线行宽度必须一致，实际 ${[...distinct].join(' / ')}：\n${bareOf(frame)}`);
				// 60% × 100 列 = 框宽 60，浮层两侧各留 2 列白（overlayOptions.padX）→ 整行 64。
				assert.equal(widths[0], 64, `框线行应是 64 列（六成宽 + 两侧各 2 列白），实际 ${widths.join(',')}`);
				terminal.send('\x1b[<65;51;16M');
			}
			terminal.send('\x1b');
			await closed;
		} finally {
			ui.stop({ preserveScreen: true });
		}
	});
});

/**
 * 审批弹窗的完整性。
 *
 * 这里守的是两条用户可见的底线:命令要逐字展示(Markdown 的转义规则会改写 `\|`
 * 这类内容,批准看到的和实际执行的必须是同一条命令);选项列表在高个子终端里
 * 全部可见、在矮终端里靠列表自身滚动消化,无论哪种,页脚提示和底边框都不许被
 * 浮层的超限裁切削掉。
 */
describe('审批弹窗的完整性', () => {
  const backslash = String.fromCharCode(92);
  const command = `grep -n "ROUTES${backslash}|def ${backslash}|path" server/api/server.py | head -80`;
  const approvalItems = [
    { value: 'allow', label: 'Allow once' },
    { value: 'session', label: 'Allow this exact command for this session' },
    { value: 'always', label: 'Always allow this exact command for this project' },
    { value: 'deny', label: 'Deny' },
  ];

  async function renderApprovalDialog(columns: number, rows: number): Promise<string> {
    const terminal = new FakeTerminal();
    terminal.columns = columns;
    terminal.rows = rows;
    const ui = new TuiAltScreen(terminal, false, '/ws');
    ui.start();
    try {
      const pending = showSelectDialog(ui, {
        title: 'Approve bash?',
        bodyText: command,
        bodyFormat: 'plain',
        items: approvalItems,
        maxVisible: 4,
      });
      ui.renderNow(true);
      const screen = terminal.screen();
      terminal.send('\x1b');
      await pending;
      return screen;
    } finally {
      ui.stop({ preserveScreen: true });
    }
  }

  it('命令预览逐字保留，不再被 Markdown 转义吃掉反斜杠', async () => {
    const screen = await renderApprovalDialog(125, 34);
    assert.ok(screen.includes(`ROUTES${backslash}|def`), '弹窗里的命令必须与实际执行的一致');
  });

  it('常见终端高度下四个选项、快捷键提示与底边框全部可见', async () => {
    const screen = await renderApprovalDialog(125, 34);
    for (const label of approvalItems) {
      assert.match(screen, new RegExp(label.label.replaceAll('|', String.raw`\|`)));
    }
    assert.match(screen, /Esc cancel/);
    assert.match(screen, /╰/);
  });

  it('矮终端下选项交给列表滚动消化，提示与底边框仍然完整', async () => {
    const screen = await renderApprovalDialog(80, 12);
    // 提示已挪进底边框左侧；窄盒装不下整串时截断（带 …），但不能整段消失。
    assert.match(screen, /↑↓ · Tab · Enter · Esc/, '紧凑档提示要留在底边框上，Esc 不能被省略号吃掉');
    assert.match(screen, /╰/, '底边框不许被裁掉');
    assert.match(screen, /1\/4/, '放不下的选项要作为可滚列表呈现');
  });
});

/** 让 TUI 把一次输入处理完（渲染是同步的，只需让出事件循环）。 */
const settle = (ms = 80): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 测试用的 MCP 服务：列表/调用走真 hub，seam 上插件侧才有的两份状态按空给。
 *
 * 本文件验的是弹窗渲染（`/mcps` 要把连不上的原因显示出来），刷新与来源报告由
 * tests/plugins/sph-mcp.test.ts 与 tests/mcp/* 覆盖，这里不重复触发。
 */
function mcpService(hub: McpHub): McpService {
  return {
    reload: async () => ({ warnings: [], added: [], removed: [], restarted: [] }),
    sources: () => [],
    warnings: () => [],
    listTools: () => hub.listTools(),
    listServers: () => hub.listServers(),
    listToolsOf: (server) => hub.listToolsOf(server),
    call: (server, name, args) => hub.call(server, name, args),
    whenReady: (timeoutMs) => hub.whenReady(timeoutMs),
    dispose: () => hub.dispose(),
  };
}

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
    mcp: () => mcpService(mcp),
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
    const mcp = new McpHub(testHostFacts());
    try {
      // 名字按字母序排最前：列表可能长过一屏，只有排在最前的条目才一定在视口内。
      const dir = join(root, '.sph', 'skills', '000-widget');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), '---\nname: 000-widget\ndescription: Widget builder\n---\n', 'utf8');

      const screen = await driveCommand(terminal, root, mcp, {}, '/skills');
      // 标题两侧隔着上色用的转义序列，断言前先剥掉 ANSI。
      const bare = screen.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
      // /skills 走报告弹窗（report/dialog.ts）：直角框 + 顶边嵌标题 + 搜索行 + 可折叠分组。
      assert.match(bare, /┌─ Skills ─/, '弹窗标题栏渲染出来（直角框）');
      assert.equal(bare.includes('Skills (1 found)'), false, '正文不再重复 Skills (N found)');
      assert.match(bare, /\/ to search/, '搜索行占位在场');
      assert.match(bare, /#\d+\s+.*\(\d+ skills?\)/, '分组头带序号与计数后缀');
      assert.match(bare, /Esc close/, 'footer 报关闭键');
      assert.match(bare, /000-widget\s+Widget builder/, '名字与说明同一行');
      const dialogSurface = theme.bgSeq('dialogBg');
      const canvasSurface = theme.bgSeq('bg');
      const boxRows = screen.split(/\x1b\[\d+;\d+H/).filter((row) => row.includes('┌─'));
      assert.ok(boxRows.length > 0, '应渲染出对话框顶边');
      assert.equal(boxRows.some((row) => row.includes(dialogSurface)), false, '技能报告框不铺浮层面色');
      assert.ok(boxRows.some((row) => row.includes(canvasSurface)), '技能报告框铺画布底，与终端同色');
      assert.match(screen, /Matched by name\+description/, '渲染的是有内容的分支而不是空分支');
      assert.match(screen, /Widget builder/, '工作区里的技能被扫到了');
      assert.equal(screen.includes('Unknown command'), false);
    } finally {
      mcp.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('/plugins 打开弹窗，列出插件与它们提供的工具', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-cmd-plugins-'));
    const terminal = new FakeTerminal();
    const mcp = new McpHub(testHostFacts());
    try {
      // 真实装载：内置插件在 src/plugins/，sph-mcp 应当出现在报告里并带上它的 mcp 工具。
      const plugins = new PluginHost({
        coreTools: [],
        workspaceRoot: root,
        configPath: join(root, 'config.toml'),
      });
      const discovered = discoverPlugins({ workspaceRoot: root, userRoot: join(root, 'no-user') });
      await plugins.load(discovered.candidates, discovered.shadowed);
      try {
        const screen = await driveCommand(
          terminal,
          root,
          mcp,
          { pluginReport: () => plugins.report() },
          '/plugins',
        );
        // 弹窗按 markdown 渲染：反引号被吃掉，行内码是**带颜色**的，剥色后再断言。
        const bare = screen.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
        // 逐插件明细的全文在 reports.test.ts：这里只看视口内必然可见的行。
        assert.match(bare, /─ Bundled with sph /, '按来源分段，来源只写一次');
        assert.equal(bare.includes('Plugins ('), false, '顶栏的数量标题已经去掉');
        assert.match(bare, /sph-llm\s+services: sph-llm/, '词项列：一插件一行，写着它贡献了什么');
        // 与 /skills 同一套版式：铺画布底，不铺浮层面。
        const dialogSurface = theme.bgSeq('dialogBg');
        const canvasSurface = theme.bgSeq('bg');
        const boxRows = screen.split(/\x1b\[\d+;\d+H/).filter((row) => row.includes('╭'));
        assert.ok(boxRows.length > 0, '应渲染出对话框顶边');
        assert.equal(boxRows.some((row) => row.includes(dialogSurface)), false, '插件报告框不铺浮层面色');
        assert.ok(boxRows.some((row) => row.includes(canvasSurface)), '插件报告框铺画布底，与终端同色');
        assert.equal(screen.includes('Unknown command'), false);
      } finally {
        plugins.dispose();
      }
    } finally {
      mcp.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('/help 是报告框：命令与键位都成了横线标题，且不再有可点选的列表', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-cmd-help-'));
    const terminal = new FakeTerminal();
    const mcp = new McpHub(testHostFacts());
    try {
      const screen = await driveCommand(terminal, root, mcp, {}, '/help');
      const bare = screen.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
      assert.match(bare, /╭─ Help ─/, '弹窗标题栏渲染出来');
      // 命令段与各分组都是正文里的横线标题：命令按 group 分段，第一个分组是 Tools。
      // 键位段在首屏之外，它的分组细则由 reports.test.ts 的纯函数用例守。
      assert.match(bare, /─ Commands /, '命令段的横线标题（不写条数）');
      assert.match(bare, /─ Tools /);
      assert.match(bare, /\/help\s+List commands and key bindings/, '词项列：命令与说明同一行');
      // 底边框是报告框的按键格；说明语已经搬回正文，这里只剩按得动的键。
      // （不能拿 `>` 反证：整屏是累积输出，编辑器补全菜单里也有选中标记。）
      assert.match(bare, /↑↓ scroll · PgDn page · Esc close/);
      assert.equal(bare.includes('↑/↓ select'), false);
      const dialogSurface = theme.bgSeq('dialogBg');
      const canvasSurface = theme.bgSeq('bg');
      const boxRows = screen.split(/\x1b\[\d+;\d+H/).filter((row) => row.includes('╭'));
      assert.ok(boxRows.length > 0, '应渲染出对话框顶边');
      assert.equal(boxRows.some((row) => row.includes(dialogSurface)), false, '帮助面板不铺浮层面色');
      assert.ok(boxRows.some((row) => row.includes(canvasSurface)), '帮助面板铺画布底，与终端同色');
      assert.equal(screen.includes('Unknown command'), false);
    } finally {
      mcp.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('/permissions 这类命令报告也套上同一套版式', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-cmd-panel-'));
    const terminal = new FakeTerminal();
    const mcp = new McpHub(testHostFacts());
    try {
      const screen = await driveCommand(terminal, root, mcp, {}, '/permissions');
      assert.match(screen.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ''), /╭─ Permissions ─/);
      const canvasSurface = theme.bgSeq('bg');
      const dialogSurface = theme.bgSeq('dialogBg');
      const rows = screen.split(/\x1b\[\d+;\d+H/).filter((row) => row.includes('╭'));
      assert.ok(rows.some((row) => row.includes(canvasSurface)), '权限报告铺画布底');
      assert.equal(rows.some((row) => row.includes(dialogSurface)), false, '权限报告不铺浮层面色');
      assert.equal(screen.includes('Unknown command'), false);
    } finally {
      mcp.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('/mcps 打开管理器，把连不上的 server 连原因一起显示出来', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-cmd-mcps-'));
    const terminal = new FakeTerminal();
    const mcp = new McpHub(testHostFacts());
    try {
      await mcp.reload([{ name: 'broken', command: 'definitely-not-a-real-binary-xyz' }]);
      await mcp.whenReady();
      const screen = await driveCommand(terminal, root, mcp, {}, '/mcps');
      assert.match(screen, /MCP servers/);
      assert.match(screen, /Servers · 1/, '数量挂在 Servers 组头上，不在顶栏');
      assert.match(screen, /broken/, 'server 名独占主列');
      assert.match(screen, /not connected · from /, '状态与来源在说明列');
      assert.match(screen, /Reload from disk/, '管理器动作要可见，而不是只读弹窗');
      // 列表框也套报告版式（铺画布底），但点选还在：`>` 是选中标记。
      const canvasSurface = theme.bgSeq('bg');
      const boxRows = screen.split(/\x1b\[\d+;\d+H/).filter((row) => row.includes('╭'));
      assert.ok(boxRows.some((row) => row.includes(canvasSurface)), '管理器铺画布底');
      assert.match(screen, /> Reload from disk/, '点选还在，选中标记是 >');
      assert.equal(screen.includes('Unknown command'), false);
    } finally {
      mcp.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('/resume 打开会话选择器并列出会话', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-cmd-resume-'));
    const terminal = new FakeTerminal();
    const mcp = new McpHub(testHostFacts());
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
    const mcp = new McpHub(testHostFacts());
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

  it('/permission 打开审批模式选择器', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-cmd-permission-'));
    const terminal = new FakeTerminal();
    const mcp = new McpHub(testHostFacts());
    try {
      const screen = await driveCommand(terminal, root, mcp, {}, '/permission');
      assert.match(screen, /Approval mode/);
      assert.equal(screen.includes('Unknown command'), false);
    } finally {
      mcp.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('/compact 把历史压成检查点，并新开一个会话', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-cmd-compact-'));
    const terminal = new FakeTerminal();
    const mcp = new McpHub(testHostFacts());
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

      assert.match(screen, /Compacted \d+ messages into a new session/);
      assert.equal(screen.includes('Unknown command'), false);
      const oldLog = readFileSync(join(root, 'test.jsonl'), 'utf8');
      assert.match(oldLog, /"kind":"session_fork"/);
      assert.equal(oldLog.includes('"kind":"compaction"'), false, '原会话不能再写会改写发送投影的 compaction 事件');
      const current = JSON.parse(readFileSync(join(root, 'current.json'), 'utf8')) as { id: string };
      assert.notEqual(current.id, 'test');
      const opened = readFileSync(join(root, `${current.id}.jsonl`), 'utf8');
      assert.match(opened, /compacted earlier context/);
    } finally {
      mcp.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
