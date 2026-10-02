/**
 * `/mcps` 管理器里剩下的上报文本与共用措辞。
 *
 * 报告本体已迁去报告弹窗的结构化数据层（`report/sources/mcps.ts`，MCP tab）；留在这里的是管理器
 * 自己还要用的两样：单个 server 的工具清单（点「Show tools」时弹），以及 server 的展示名与状态
 * 短语——那两句是**共用措辞**，管理器与报告 tab 各写一遍，迟早会把同一个 server 说成两种状态。
 *
 * 只做「数据 → markdown」，不碰 TUI：拉取数据留在命令里，排版留在纯函数里。这样这份文本不用
 * 驱动整个 TUI 就能测，而它恰恰最容易退化成空壳——server 连不上、路径里带反引号，都是真实会
 * 遇到而手测很容易漏的分支。
 *
 * **正文段落一律写成一行源文本**，别手工折行：markdown 把段内的换行当硬换行保留（转录区
 * 要照搬模型自己的换行），手折过的段落会被逐行再按弹窗宽度折一次，于是出现
 * 「…can use. A / tool you / expected…」这种碎句。宽度是浮动的，折行只能交给渲染器。
 */

import type { McpServerStatus } from '@/plugins/services.js';

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

/** 有显示名时写成 `Title (id)`。调用和启停仍用括号里的 ID。 */
export function mcpServerLabel(server: { name: string; title?: string }): string {
  if (server.title !== undefined && server.title !== '' && server.title !== server.name) {
    return `${server.title} (${server.name})`;
  }
  return server.name;
}

/** 单个 server 的工具清单；`/mcps` 里点「Show tools」用。 */
export function renderMcpTools(server: McpServerStatus): string {
  const lines: string[] = [`**${plain(mcpServerLabel(server))}**`, '', `from ${code(server.origin.label)}`, ''];
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
