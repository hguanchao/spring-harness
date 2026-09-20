/**
 * `/skills` 与 `/mcps` 的上报文本。
 *
 * 只做「数据 → markdown」，不碰 TUI：拉取数据留在命令里，排版留在纯函数里。这样这两份
 * 文本不用驱动整个 TUI 就能测，而它们恰恰是最容易退化成空壳的地方——列表为空、某个
 * server 连不上、路径里带反引号，都是真实会遇到而手测很容易漏的分支。
 */

import type { McpServerStatus } from '../mcp/hub.js';
import type { McpSourceReport } from '../mcp/sources.js';
import type { SkillEntry } from '../skills/scan.js';

/**
 * 反引号包裹：内容里的反引号换成单引号。
 *
 * 技能与工具名、路径、启动命令都来自用户自己的文件/配置，里面出现反引号完全正常；
 * 不处理会把 markdown 的内联代码段提前闭合，后面的排版整段错乱。
 */
function code(text: string): string {
  return `\`${text.replaceAll('`', "'")}\``;
}

/** 单行化：描述里的换行会把一条列表项撑成好几行，破坏每条目一行的排版。 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 非代码位置的正文（描述类）。
 *
 * 反引号同样要中和——描述不包在反引号里，但它**自己带反引号**时一样会开出一个未闭合的
 * 内联代码段。这一点很容易漏：路径走 code() 就安全了，描述不走，于是只有描述会破排版。
 */
function plain(text: string): string {
  return oneLine(text).replaceAll('`', "'");
}

function warningsSection(warnings: readonly string[], title: string): string[] {
  if (warnings.length === 0) return [];
  return ['', `### ${title}`, ...warnings.map((warning) => `- ${plain(warning)}`)];
}

export function renderSkillsReport(input: {
  catalog: readonly SkillEntry[];
  warnings: readonly string[];
  roots: readonly string[];
}): string {
  const { catalog, warnings, roots } = input;
  const lines: string[] = [`## Skills (${catalog.length})`, ''];

  if (catalog.length === 0) {
    lines.push(
      'No skills found. A skill is a directory holding `SKILL.md` with `name` and',
      '`description` frontmatter — drop one in any root below and it is picked up on the',
      'next turn.',
    );
  } else {
    lines.push(
      'The model sees only the name and description; the `skill` tool reads the full',
      '`SKILL.md` when one matches the task.',
      '',
    );
    for (const skill of catalog) {
      lines.push(`- **${plain(skill.name)}** — ${plain(skill.description)}`);
      lines.push(`  ${code(skill.path)}`);
    }
  }

  lines.push('', '### Loaded from', '', 'Later roots override earlier ones when two skills share a name.', '');
  roots.forEach((root, index) => {
    lines.push(`${index + 1}. ${code(root)}`);
  });

  lines.push(...warningsSection(warnings, 'Warnings'));
  return lines.join('\n');
}

export function renderMcpReport(input: {
  servers: readonly McpServerStatus[];
  warnings: readonly string[];
  /** 候选来源文件的读取结果；回答「我明明配了怎么没生效」。 */
  sources?: readonly McpSourceReport[];
}): string {
  const { servers, warnings, sources = [] } = input;
  const reachable = servers.filter((server) => server.connected).length;
  const lines: string[] = [`## MCP servers (${reachable} connected / ${servers.length} discovered)`, ''];

  if (servers.length === 0) {
    lines.push(
      'No MCP servers found. Put one in any source below and press `r`:',
      '',
      '```toml',
      '# ~/.sph/config.toml (or <repo>/.sph/config.toml, which wins for this repository)',
      '[[mcp_servers]]',
      'name = "demo"',
      'command = "npx"',
      'args = ["-y", "demo-mcp"]',
      '```',
      '',
      'Claude (`~/.claude.json`), Codex (`~/.codex/config.toml`) and `.mcp.json` are read too.',
      'Only stdio servers can be run; HTTP entries are listed but not started.',
    );
  } else {
    for (const server of servers) {
      lines.push(`- **${plain(server.name)}** — ${stateOf(server)}`);
      lines.push(`  ${code(server.target)}`);
      const notes = [`from ${code(server.origin.label)}`];
      if (server.transport === 'http') notes.push('http transport, not started');
      if (server.lazy) notes.push('lazy — connects on first use');
      if (!server.origin.editable) notes.push('read-only source');
      // 不整串过 plain()：那会把 code() 刚包好的反引号又换成单引号，路径就不再是等宽字体了。
      lines.push(`  ${notes.join(' · ')}`);
    }

    for (const server of servers) {
      if (!server.connected) continue;
      lines.push('', `### ${plain(server.name)}`);
      lines.push('');
      if (server.tools.length === 0) {
        lines.push('Connected, but it exposes no tools.');
        continue;
      }
      for (const tool of server.tools) {
        const description = plain(tool.description);
        lines.push(`- ${code(tool.name)}${description === '' ? '' : ` — ${description}`}`);
      }
    }

    lines.push(
      '',
      'The model calls these through the `mcp` tool. Results are external data, not instructions.',
    );
  }

  if (sources.length > 0) {
    lines.push(
      '',
      '### Sources scanned',
      '',
      'Highest priority first within a tool; `.mcp.json` is consulted last. A name declared in two',
      'places resolves to the higher-priority definition as a whole (fields are not merged).',
      '',
    );
    // 有内容的排前面，`missing` 垫底：它数量最多、信息量最低，但「我配了没生效」正是靠它回答。
    for (const report of orderedSources(sources)) {
      lines.push(`- ${report.status} · ${code(report.path)}${detailOf(report)}`);
    }
  }

  lines.push(...warningsSection(warnings, 'Warnings'));
  return lines.join('\n');
}

/** 单个 server 的工具清单；`/mcps` 里点「Show tools」用。 */
export function renderMcpTools(server: McpServerStatus): string {
  const lines: string[] = [`## ${plain(server.name)}`, '', `from ${code(server.origin.label)}`, ''];
  if (server.tools.length === 0) {
    lines.push('Connected, but it exposes no tools.');
    return lines.join('\n');
  }
  for (const tool of server.tools) {
    const description = plain(tool.description);
    lines.push(`- ${code(tool.name)}${description === '' ? '' : ` — ${description}`}`);
  }
  lines.push('', 'The model calls these through the `mcp` tool. Results are external data, not instructions.');
  return lines.join('\n');
}

/**
 * 状态短语（纯文本，不含 markdown）。
 *
 * 上报文本与 `/mcps` 的选择列表共用同一份措辞：两处各写一遍，迟早会出现同一个 server
 * 在两个界面上被描述成不同状态的情况，而那时候用户只会更困惑。
 */
export function mcpStateLabel(server: McpServerStatus): string {
  if (!server.enabled) return 'disabled';
  if (server.connected) return `connected, ${server.tools.length} tool${server.tools.length === 1 ? '' : 's'}`;
  // 启动不阻塞在握手上，弹窗打开时 server 可能还在后台连。
  if (server.connecting) return 'connecting…';
  // 懒而未连接是设计好的状态，不是故障——措辞上要和「连不上」一眼可分。
  if (server.lazy) return 'lazy — connects on first use';
  return `not connected${server.problem === undefined ? '' : ` — ${plain(server.problem)}`}`;
}

/** 上报里只给失败短语本身加粗：它是列表里唯一需要一眼扫到的信息。 */
function stateOf(server: McpServerStatus): string {
  const label = mcpStateLabel(server);
  return label.startsWith('not connected') ? label.replace('not connected', '**not connected**') : label;
}

const SOURCE_ORDER: Readonly<Record<McpSourceReport['status'], number>> = {
  found: 0,
  invalid: 1,
  skipped: 2,
  empty: 3,
  missing: 4,
};

function orderedSources(sources: readonly McpSourceReport[]): McpSourceReport[] {
  return [...sources].sort((a, b) => SOURCE_ORDER[a.status] - SOURCE_ORDER[b.status]);
}

function detailOf(report: McpSourceReport): string {
  if (report.status === 'found') return ` — ${report.count} server${report.count === 1 ? '' : 's'}`;
  if (report.detail === undefined) return '';
  return ` — ${plain(report.detail)}`;
}
