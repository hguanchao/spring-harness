/**
 * `/mcps` 的上报文本。
 *
 * `/skills`、`/plugins`、`/permissions`、`/help` 已经迁去报告弹窗的结构化数据层
 * （`report/sources/*`）；`/mcps` 暂留 markdown：它是**管理器**（启停/新增/删除/重载），
 * 等报告 tab 能挂动作之后再把报告并进去。
 *
 * 只做「数据 → markdown」，不碰 TUI：拉取数据留在命令里，排版留在纯函数里。这样这份
 * 文本不用驱动整个 TUI 就能测，而它恰恰最容易退化成空壳——server 连不上、路径里带
 * 反引号，都是真实会遇到而手测很容易漏的分支。
 *
 * **正文段落一律写成一行源文本**，别手工折行：markdown 把段内的换行当硬换行保留（转录区
 * 要照搬模型自己的换行），手折过的段落会被逐行再按弹窗宽度折一次，于是出现
 * 「…can use. A / tool you / expected…」这种碎句。宽度是浮动的，折行只能交给渲染器。
 */

import type { McpServerStatus } from '@/plugins/services.js';
import type { McpSourceReport } from '@/plugins/services.js';

/**
 * 反引号包裹：内容里的反引号换成单引号。
 *
 * 工具名、路径、启动命令都来自用户自己的文件/配置，里面出现反引号完全正常；
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

export function renderMcpReport(input: {
  servers: readonly McpServerStatus[];
  warnings: readonly string[];
  /** 候选来源文件的读取结果；回答「我明明配了怎么没生效」。 */
  sources?: readonly McpSourceReport[];
}): string {
  const { servers, warnings, sources = [] } = input;
  const reachable = servers.filter((server) => server.connected).length;
  const lines: string[] = [
    // 「状态是当下取的」这句原来挤在底边框提示里，被省略号截掉；报告正文才是它该在的位置。
    `### MCP servers (${reachable} connected / ${servers.length} discovered) — status is live as of this frame`,
    '',
  ];

  if (servers.length === 0) {
    lines.push(
      'No MCP servers found. Put one in any source below and press `r`:',
      '',
      '```toml',
      '# ~/.sph/config.toml (or <repo>/.sph/config.toml, which wins for this repository)',
      '[mcp_servers.demo]',
      'name = "Demo"',
      'type = "stdio"',
      'command = "npx"',
      'args = ["-y", "demo-mcp"]',
      '```',
      '',
      'External MCP configs and `.mcp.json` are read too.',
      'stdio, HTTP, and SSE servers are started. Set `type = "sse"` when the URL is the legacy event stream.',
    );
  } else {
    for (const server of servers) {
      lines.push(`- **${plain(mcpServerLabel(server))}** — ${stateOf(server)}`);
      lines.push(`  ${code(server.target)}`);
      const notes = [`from ${code(server.origin.label)}`];
      if (server.transport !== 'stdio') notes.push(server.transport);
      if (!server.origin.editable) notes.push('read-only source');
      // 不整串过 plain()：那会把 code() 刚包好的反引号又换成单引号，路径就不再是等宽字体了。
      lines.push(`  ${notes.join(' · ')}`);
    }

    for (const server of servers) {
      if (!server.connected) continue;
      lines.push('', `### ${plain(mcpServerLabel(server))}`);
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
      'Highest priority first within a tool; `.mcp.json` is consulted last. A name declared in two places resolves to the higher-priority definition as a whole (fields are not merged).',
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

/** 有显示名时写成 `Title (id)`。调用和启停仍用括号里的 ID。 */
export function mcpServerLabel(server: { name: string; title?: string }): string {
  if (server.title !== undefined && server.title !== '' && server.title !== server.name) {
    return `${server.title} (${server.name})`;
  }
  return server.name;
}

/** 单个 server 的工具清单；`/mcps` 里点「Show tools」用。 */
export function renderMcpTools(server: McpServerStatus): string {
  const lines: string[] = [`### ${plain(mcpServerLabel(server))}`, '', `from ${code(server.origin.label)}`, ''];
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
