import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderHelpReport, renderMcpReport, renderPluginsReport, renderSkillsReport } from '@/plugins/sph-tui/commands/reports.js';
import type { LoadedPlugin } from '@/plugins/host.js';
import type { McpServerStatus } from '@/plugins/services.js';
import type { McpSourceReport } from '@/plugins/services.js';
import type { SkillEntry, SkillRoot } from '@/plugins/sph-skills/scan.js';
import type { AppKeybindingDefinition } from '@/plugins/sph-tui/input/app-keybindings.js';
import type { CommandItem } from '@/plugins/sph-tui/commands/index.js';

/** 测试里的技能根：`level` 决定组标题写 User 还是 Project。 */
function root(path: string, level: 'User' | 'Project' = 'User'): SkillRoot {
  return { path, level };
}

function skill(name: string, description: string, root = '/ws/skills'): SkillEntry {
  return { name, description, root, path: `${root}/${name}/SKILL.md` };
}

function server(overrides: Partial<McpServerStatus> & { name: string }): McpServerStatus {
  return {
    transport: 'stdio',
    supported: true,
    enabled: true,
    connected: true,
    target: `npx -y ${overrides.name}-mcp`,
    origin: { label: '~/.sph/config.toml', path: '/home/u/.sph/config.toml', editable: true },
    tools: [],
    ...overrides,
  };
}

function source(overrides: Partial<McpSourceReport> & { path: string }): McpSourceReport {
  return { label: '.mcp.json', status: 'found', count: 1, ...overrides };
}

describe('renderSkillsReport', () => {
  it('单一来源：也画组标题（技能从哪来就是要确认的事），一条技能一行', () => {
    const text = renderSkillsReport({
      catalog: [skill('pdf', 'Fill PDF forms', '/ws/.sph/skills'), skill('sheet', 'Edit spreadsheets', '/ws/.sph/skills')],
      warnings: [],
      roots: [root('/ws/.sph/skills', 'Project')],
    });
    assert.match(text, /### #1 {2}Project — \/ws\/\.sph\/skills · 2/, '只有一个来源也标出来源与条数');
    assert.match(text, /- `pdf` — Fill PDF forms/);
    assert.equal(text.includes('/ws/.sph/skills/pdf/SKILL.md'), false, '路径上收到组标题，不再逐条占行');
    assert.equal(text.includes('### Loaded from'), false, '有货时不画「空根清单」');
    assert.equal(text.includes('resolves to the lower #'), false, '只有一个来源就不提覆盖次序');
  });

  it('多来源：按覆盖次序编号，#1 是会赢的那个，标题写明 User 还是 Project', () => {
    const text = renderSkillsReport({
      catalog: [
        skill('pdf', 'Fill PDF forms', '/ws/.sph/skills'),
        skill('grill', 'Grill plans', '/home/u/.agents/skills'),
      ],
      warnings: [],
      roots: [root('/home/u/.agents/skills'), root('/ws/.sph/skills', 'Project')],
    });
    // 后者覆盖前者：/ws/.sph/skills 是 #1，而它在 roots 里排最后。
    assert.ok(
      text.indexOf('#1  Project — /ws/.sph/skills') < text.indexOf('#2  User — /home/u/.agents/skills'),
      '号按优先级排，且标题带上分级',
    );
    assert.match(text, /#1 {2}Project — \/ws\/\.sph\/skills · 1/);
    assert.match(text, /A skill advertised by two roots resolves to the lower #/);
    assert.equal(text.includes('### Skills 2'), false, '分了组就不再另起一个总数标题');
  });

  it('空目录时不说「0 个」就完，而是讲清技能长什么样、该放哪', () => {
    const text = renderSkillsReport({ catalog: [], warnings: [], roots: [root('/ws/.sph/skills', 'Project')] });
    assert.equal(/^## Skills/m.test(text), false);
    assert.equal(text.includes('### Skills 0'), false, '没有条目就不挂一个空标题');
    assert.match(text, /No skills found/);
    assert.match(text, /`SKILL\.md`/);
    assert.match(text, /### Roots/, '空列表时根目录清单反而最有用');
    assert.match(text, /1\. \{\{Project — \/ws\/\.sph\/skills\}\}/, '根清单也带分级');
    assert.match(text, /lower number wins/, '号的含义写在标题上，不用读者猜');
  });

  it('没货的根只占一句，且路径逐字保留', () => {
    const text = renderSkillsReport({
      catalog: [skill('pdf', 'Fill PDF forms', 'C:\\Users\\u\\.agents\\skills')],
      warnings: [],
      roots: [
        root('C:\\Users\\u\\.agents\\skills'),
        root('C:\\Users\\u\\.claude\\skills'),
        root('/ws/.sph/skills', 'Project'),
      ],
    });
    assert.match(text, /nothing found in 2 other roots/);
    assert.match(text, /%%[^%\n]*\.claude\\skills[^%\n]*%%/, '空根用 %%…%%：反斜杠不会被当成转义吃掉');
  });

  it('描述里的反引号被替换，不会提前闭合内联代码段', () => {
    const text = renderSkillsReport({
      catalog: [skill('pdf', 'Use `pdftk` to fill')],
      warnings: [],
      roots: [],
    });
    assert.ok(text.includes("Use 'pdftk' to fill"));
    assert.equal((text.match(/`/g) ?? []).length % 2, 0, '内联代码段必须成对');
  });

  it('多行描述压成一行，一条技能只占两行', () => {
    const text = renderSkillsReport({
      catalog: [skill('pdf', 'Fill forms\nand merge\nfiles')],
      warnings: [],
      roots: [],
    });
    assert.ok(text.includes('- `pdf` — Fill forms and merge files'));
  });

  it('没有警告时不出现 Warnings 段', () => {
    const text = renderSkillsReport({ catalog: [], warnings: [], roots: [] });
    assert.equal(text.includes('### Warnings'), false);
  });

  it('有警告时逐条列出', () => {
    const text = renderSkillsReport({
      catalog: [],
      warnings: ['skipped skill without name/description frontmatter: /ws/x/SKILL.md'],
      roots: [],
    });
    assert.match(text, /### Warnings/);
    assert.match(text, /skipped skill without name\/description frontmatter/);
  });
});

describe('renderMcpReport', () => {
  it('未配置时给出一段可直接抄的配置，并说明三种传输都会启动', () => {
    const text = renderMcpReport({ servers: [], warnings: [] });
    assert.match(text, /### MCP servers \(0 connected \/ 0 discovered\)/);
    assert.match(text, /\[mcp_servers\.demo\]/);
    assert.match(text, /name = "Demo"/);
    assert.match(text, /type = "stdio"/);
    assert.match(text, /stdio, HTTP, and SSE servers are started/);
    assert.match(text, /External MCP configs/, '空列表时要说明还会读外部配置');
  });

  it('显示名和 ID 不同时一起写出来', () => {
    const text = renderMcpReport({
      servers: [server({ name: 'tavily', title: 'Tavily', connected: false, problem: 'not connected' })],
      warnings: [],
    });
    assert.match(text, /\*\*Tavily \(tavily\)\*\*/);
  });

  it('已连接的 server 标出工具数并逐个列出工具', () => {
    const text = renderMcpReport({
      servers: [
        server({
          name: 'demo',
          tools: [
            { server: 'demo', name: 'read_thing', description: 'Read a thing', schema: {} },
            { server: 'demo', name: 'write_thing', description: 'Write a thing', schema: {} },
          ],
        }),
      ],
      warnings: [],
    });
    assert.match(text, /\*\*demo\*\* — connected, 2 tools/);
    assert.match(text, /### demo/);
    assert.match(text, /`read_thing` — Read a thing/);
    assert.match(text, /`write_thing` — Write a thing/);
  });

  it('未连接的 server 必须出现，且不列工具', () => {
    // 「配置了但连不上」正是最需要看见的状态——只列已连接的服务端等于把问题藏起来。
    const text = renderMcpReport({
      servers: [server({ name: 'broken', connected: false, tools: [] })],
      warnings: ['broken: spawn npx ENOENT'],
    });
    assert.match(text, /\*\*broken\*\* — \*\*not connected\*\*/);
    assert.equal(text.includes('### broken'), false, '没连上就没有工具可列');
    // 这一段现在同时承载来源读取、信任门与装载失败三类警告，「Startup」已不够准确。
    assert.match(text, /### Warnings/);
    assert.match(text, /broken: spawn npx ENOENT/);
  });

  it('启动命令带空格时加引号，免得看起来像两个参数', () => {
    const text = renderMcpReport({
      servers: [server({ name: 'local', target: '"C:\\Program Files\\node\\node.exe" serve' })],
      warnings: [],
    });
    assert.match(text, /`"C:\\Program Files\\node\\node\.exe" serve`/);
  });

  it('标出来源与只读性：外部配置不会被 sph 改写', () => {
    const text = renderMcpReport({
      servers: [
        server({
          name: 'fromclaude',
          origin: { label: '~/.claude.json', path: '/home/u/.claude.json', editable: false },
        }),
      ],
      warnings: [],
    });
    assert.match(text, /from `~\/\.claude\.json`/);
    assert.match(text, /read-only source/);
  });

  it('HTTP server 照实列出传输和失败原因，而不是静默消失', () => {
    const text = renderMcpReport({
      servers: [
        server({
          name: 'remote',
          transport: 'http',
          supported: true,
          connected: false,
          target: 'https://mcp.example.com/mcp',
          problem: 'HTTP 500: boom',
        }),
      ],
      warnings: [],
    });
    assert.match(text, /\*\*remote\*\* — \*\*not connected\*\* — HTTP 500: boom/);
    assert.match(text, /https:\/\/mcp\.example\.com\/mcp/);
    assert.match(text, / · http$/m);
  });

  it('被禁用的 server 与「连不上」区分开：前者不是故障', () => {
    const text = renderMcpReport({
      servers: [server({ name: 'off', enabled: false, connected: false, problem: 'disabled' })],
      warnings: [],
    });
    assert.match(text, /\*\*off\*\* — disabled$/m);
    assert.equal(text.includes('not connected'), false, '主动关掉的不该显示成故障');
  });

  it('来源清单把有内容的排前面，missing 垫底', () => {
    const text = renderMcpReport({
      servers: [server({ name: 'demo' })],
      warnings: [],
      sources: [
        source({ path: '/ws/.mcp.json', status: 'missing', count: 0 }),
        source({ path: '/home/u/.claude.json', status: 'found', count: 2 }),
        source({ path: '/ws/.codex/config.toml', status: 'skipped', count: 0, detail: '已导入' }),
      ],
    });
    assert.match(text, /### Sources scanned/);
    assert.match(text, /- found · `\/home\/u\/\.claude\.json` — 2 servers/);
    const found = text.indexOf('/home/u/.claude.json');
    const skipped = text.indexOf('/ws/.codex/config.toml');
    const missing = text.indexOf('/ws/.mcp.json');
    assert.ok(found < skipped && skipped < missing, 'missing 数量最多、信息量最低，排在最后');
  });

  it('连上但零工具的 server 明说这一点，不留空段', () => {
    const text = renderMcpReport({ servers: [server({ name: 'empty' })], warnings: [] });
    assert.match(text, /Connected, but it exposes no tools\./);
  });

  it('工具没有描述时不留下孤立的破折号', () => {
    const text = renderMcpReport({
      servers: [server({ name: 'demo', tools: [{ server: 'demo', name: 'ping', description: '', schema: {} }] })],
      warnings: [],
    });
    assert.match(text, /^- `ping`$/m);
  });

  it('工具描述里的反引号同样被中和，不留下未闭合的代码段', () => {
    // 描述走 plain() 而不走 code()，正是最容易漏掉这一个中和的调用点。
    const text = renderMcpReport({
      servers: [
        server({
          name: 'demo',
          tools: [{ server: 'demo', name: 'grep', description: 'Run `rg` under the hood', schema: {} }],
        }),
      ],
      warnings: [],
    });
    assert.ok(text.includes("Run 'rg' under the hood"));
    assert.equal((text.match(/`/g) ?? []).length % 2, 0, '内联代码段必须成对');
  });
});

describe('renderPluginsReport', () => {
  function plugin(overrides: Partial<LoadedPlugin> & { name: string }): LoadedPlugin {
    return { entries: ['/x/index.ts'], root: 'bundled', tools: [], services: [], commands: [], warnings: [], ...overrides };
  }

  it('按来源分组、一插件一行：来源只写一次，摘要写清贡献了什么', () => {
    const text = renderPluginsReport({
      plugins: [
        plugin({ name: 'sph-mcp', tools: ['mcp'], services: ['sph-mcp'] }),
        plugin({ name: 'todo', root: 'user', entries: ['~/.sph/plugins/todo.ts'] }),
      ],
      failures: [],
      shadowed: [],
    });
    assert.match(text, /### Bundled with sph/);
    assert.match(text, /### User — ~\/\.sph\/plugins/);
    // 一条插件一行：工具/服务/命令只列非空的，用 · 串起来。
    assert.match(text, /- `sph-mcp` — tools: `mcp` · services: `sph-mcp`/);
    // 全空时明说，不留空白让人以为被截断。
    assert.match(text, /- `todo` — registers nothing/);
    // 来源标题每组只出现一次，不再逐条重复 from。
    assert.equal((text.match(/Bundled with sph/g) ?? []).length, 1);
    // 入口只给第三方插件留灰色注脚（和 /skills 的路径同一档），并只留尾部三段。
    assert.match(text, /^ {2}%%…\/\.sph\/plugins\/todo\.ts%%$/m);
    assert.equal(text.includes('/x/index.ts'), false, '内置插件的入口是固定位置，不进画面');
  });

  it('长入口路径截到尾部三段，来源由分组标题交代', () => {
    const text = renderPluginsReport({
      plugins: [
        plugin({
          name: 'todo',
          root: 'project',
          entries: ['E:\\Programs\\IdeaProjects\\spring-harness\\.sph\\plugins\\todo\\index.ts'],
        }),
      ],
      failures: [],
      shadowed: [],
    });
    assert.match(text, /^ {2}%%…\/plugins\/todo\/index\.ts%%$/m);
    assert.equal(text.includes('Programs\\IdeaProjects'), false, '构建目录前缀不进画面');
  });

  it('一个插件都没有时说清插件该放哪、以及被禁用是正常原因', () => {
    const text = renderPluginsReport({ plugins: [], failures: [], shadowed: [] });
    assert.match(text, /No plugins loaded/);
    assert.match(text, /src\/plugins\//);
    assert.match(text, /~\/\.sph\/plugins\//);
    // 「工具表里没有 todo」最容易的答案是配置禁用了它，所以这里必须给出来。
    assert.match(text, /disabled = \["sph-mcp"\]/);
  });

  it('说明段写成单行源文本：手折过的段落会被渲染器逐行再折一次，冒出碎句', () => {
    // `^…$` 能匹配到整句，就说明中间没有换行。markdown 把段内换行当硬换行保留，
    // 手工折过的段落会被按弹窗宽度再折一遍——「…can use. A / tool you / expected」就是它。
    const plugins = renderPluginsReport({ plugins: [], failures: [], shadowed: [] });
    assert.match(plugins, /^No plugins loaded\..*third-party ones go in/m);
    const skills = renderSkillsReport({ catalog: [], warnings: [], roots: [] });
    assert.match(skills, /^No skills found\..*next turn\.$/m);
  });

  it('加载失败单独成段，带上入口与原因', () => {
    const text = renderPluginsReport({
      plugins: [],
      failures: [{ name: 'broken', entries: ['/ws/.sph/plugins/broken.ts'], reason: 'Unexpected token' }],
      shadowed: [],
    });
    assert.match(text, /### Failed to load/);
    assert.match(text, /@@broken@@ — Unexpected token/);
    assert.match(text, /\/ws\/\.sph\/plugins\/broken\.ts/);
  });

  it('遮蔽内置插件时说明是替换而非合并', () => {
    const text = renderPluginsReport({
      plugins: [plugin({ name: 'sph-mcp', root: 'project', tools: [] })],
      failures: [],
      shadowed: ['sph-mcp'],
    });
    assert.match(text, /### Shadowing/);
    assert.match(text, /- sph-mcp$/m);
    // 关键语义：被顶掉的内置实现是消失了，不是与第三方实现合并。
    assert.match(text, /gone, not merged/);
  });

  it('原因里的反引号被中和，不留下未闭合的代码段', () => {
    const text = renderPluginsReport({
      plugins: [],
      failures: [{ name: 'x', entries: [], reason: "Cannot find module './a.ts'" }],
      shadowed: [],
    });
    assert.equal((text.match(/`/g) ?? []).length % 2, 0, '内联代码段必须成对');
  });
});

describe('renderHelpReport', () => {
  const commands: CommandItem[] = [
    { id: 'help', label: '/help', hint: 'List commands and key bindings', group: 'Tools' },
    { id: 'resume', label: '/resume', hint: 'Resume a previous session, or switch by id', group: 'Session' },
    { id: 'model', label: '/model', hint: 'Choose a model', group: 'Model & Input' },
  ];
  const keybindings: AppKeybindingDefinition[] = [
    { keys: ['escape'], description: 'cancel / interrupt the running turn', when: 'turn running' },
    { keys: ['ctrl+o'], description: 'expand tool output', when: 'always' },
  ];

  it('先说明、再按注册表顺序分段列命令', () => {
    const text = renderHelpReport({ commands, aliases: {}, keybindings: [] });
    // 标题不写命令条数：下面就是完整清单，数字只是噪音。
    assert.match(text, /^### Commands$/m);
    assert.ok(text.indexOf('### Commands') > text.indexOf('Type `/` in the editor'));
    assert.ok(text.indexOf('### Tools') < text.indexOf('- `/help`'));
    assert.ok(text.indexOf('### Tools') < text.indexOf('### Session'));
    assert.ok(text.indexOf('### Session') < text.indexOf('### Model & Input'));
    assert.equal(/^## /m.test(text), false, '报告里区块一律 h3，不留二级标题');
  });

  it('别名挂在正名旁边：靠旧名字找命令的人不能以为它没了', () => {
    const text = renderHelpReport({ commands, aliases: { sessions: 'resume' }, keybindings: [] });
    assert.match(
      text,
      /- `\/resume` — Resume a previous session, or switch by id {2}%%also \/sessions%%/,
    );
  });

  it('键位按生效上下文分段：同一个键在不同状态下做的事不同', () => {
    const text = renderHelpReport({ commands: [], aliases: {}, keybindings });
    assert.match(text, /### Keys · available anytime/);
    assert.match(text, /### Keys · turn running/);
    assert.match(text, /- `Ctrl\+O` — expand tool output/);
    assert.match(text, /- `Escape` — cancel \/ interrupt the running turn/);
  });

  it('队列与编辑器说明照旧留在尾部（注册表里没有可取的来源）', () => {
    const text = renderHelpReport({ commands: [], aliases: {}, keybindings: [] });
    assert.match(text, /### Queue \(mouse\)/);
    assert.match(text, /\[Send now\]/);
    assert.match(text, /### Editor/);
    assert.match(text, /Alt\+Enter/);
  });
});
