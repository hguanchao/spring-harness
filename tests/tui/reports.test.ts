import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderMcpReport, renderPluginsReport, renderSkillsReport } from '../../src/plugins/sph-tui/reports.js';
import type { LoadedPlugin } from '../../src/plugins/host.js';
import type { McpServerStatus } from '../../src/plugins/services.js';
import type { McpSourceReport } from '../../src/plugins/services.js';
import type { SkillEntry } from '../../src/plugins/sph-skills/scan.js';

function skill(name: string, description: string, path = `/ws/skills/${name}/SKILL.md`): SkillEntry {
  return { name, description, path };
}

function server(overrides: Partial<McpServerStatus> & { name: string }): McpServerStatus {
  return {
    transport: 'stdio',
    supported: true,
    enabled: true,
    lazy: false,
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
  it('列出名称、描述与路径，并把根目录按顺序编号', () => {
    const text = renderSkillsReport({
      catalog: [skill('pdf', 'Fill PDF forms'), skill('sheet', 'Edit spreadsheets')],
      warnings: [],
      roots: ['/home/u/.agents/skills', '/ws/.sph/skills'],
    });
    assert.match(text, /## Skills \(2\)/);
    assert.match(text, /\*\*pdf\*\* — Fill PDF forms/);
    assert.match(text, /`\/ws\/skills\/pdf\/SKILL.md`/);
    assert.ok(text.indexOf('1. `/home/u/.agents/skills`') < text.indexOf('2. `/ws/.sph/skills`'));
    assert.match(text, /Later roots override earlier ones/);
  });

  it('空目录时不说「0 个」就完，而是讲清技能长什么样、该放哪', () => {
    const text = renderSkillsReport({ catalog: [], warnings: [], roots: ['/ws/.sph/skills'] });
    assert.match(text, /## Skills \(0\)/);
    assert.match(text, /No skills found/);
    assert.match(text, /`SKILL\.md`/);
    assert.match(text, /`\/ws\/\.sph\/skills`/, '空列表时根目录清单反而最有用');
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
    assert.ok(text.includes('- **pdf** — Fill forms and merge files'));
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
    assert.match(text, /## MCP servers \(0 connected \/ 0 discovered\)/);
    assert.match(text, /\[mcp_servers\.demo\]/);
    assert.match(text, /name = "Demo"/);
    assert.match(text, /type = "stdio"/);
    assert.match(text, /stdio, HTTP, and SSE servers are started/);
    assert.match(text, /\.codex\/config\.toml/, '空列表时最该告诉用户还有哪些来源');
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

  it('列出每个插件的来源、工具与服务', () => {
    const text = renderPluginsReport({
      plugins: [
        plugin({ name: 'sph-mcp', tools: ['mcp'], services: ['sph-mcp'] }),
        plugin({ name: 'todo', root: 'user', entries: ['~/.sph/plugins/todo.ts'] }),
      ],
      failures: [],
      shadowed: [],
    });
    assert.match(text, /## Plugins \(2\)/);
    assert.match(text, /### sph-mcp/);
    assert.match(text, /bundled with sph/);
    assert.match(text, /- tools: `mcp`/);
    assert.match(text, /- services: `sph-mcp`/);
    // 没有工具/服务的插件要显式写 none，而不是留空行让人以为被截断。
    assert.match(text, /- tools: none/);
    assert.match(text, /- commands: none/);
    assert.match(text, /### todo/);
    assert.match(text, /~\/\.sph\/plugins/);
  });

  it('一个插件都没有时说清插件该放哪、以及被禁用是正常原因', () => {
    const text = renderPluginsReport({ plugins: [], failures: [], shadowed: [] });
    assert.match(text, /## Plugins \(0\)/);
    assert.match(text, /No plugins loaded/);
    assert.match(text, /src\/plugins\//);
    assert.match(text, /~\/\.sph\/plugins\//);
    // 「工具表里没有 todo」最容易的答案是配置禁用了它，所以这里必须给出来。
    assert.match(text, /disabled = \["sph-mcp"\]/);
  });

  it('加载失败单独成段，带上入口与原因', () => {
    const text = renderPluginsReport({
      plugins: [],
      failures: [{ name: 'broken', entries: ['/ws/.sph/plugins/broken.ts'], reason: 'Unexpected token' }],
      shadowed: [],
    });
    assert.match(text, /### Failed to load/);
    assert.match(text, /\*\*broken\*\* — Unexpected token/);
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
