/**
 * MCP server 的启停、增删与重载。
 *
 * 选择器作为 MCP 报告上方的第二层悬浮面板；配置写回（config/mcp-write）后经宿主重载。
 * 宿主只需要提供 ui、deps 与通知行——这一域不触碰会话与轮次状态，是命令里最独立的一块。
 */

import { removeSphMcpServer, setSphMcpDisabled, splitCommandLine, upsertSphMcpServer } from '@/config/mcp-write.js';
import type { TUI } from '@/tui/index.js';
import type { TuiDeps } from '@/plugins/sph-tui/deps.js';
import { commandPanelOptions, showConfirmDialog, showInputDialog, showMessageDialog, showSelectDialog } from '@/plugins/sph-tui/dialogs.js';
import { mcpServerLabel, mcpStateLabel, renderMcpTools } from '@/plugins/sph-tui/commands/reports.js';
import type { ReportContext } from '@/plugins/sph-tui/report/registry.js';
import { SERVER_PREFIX } from '@/plugins/sph-tui/commands/index.js';

/** MCP 命令需要的宿主能力。 */
export interface McpCommandHost {
  ui: TUI;
  deps: TuiDeps;
  addNotice(text: string, level?: 'dim' | 'warn' | 'error' | 'success'): void;
  /** 「Show full report」落到报告弹窗的 MCP tab；取数环境与 /skills、/plugins 同一份。 */
  reportContext(): ReportContext;
}

/**
 * MCP 报告里按 `m` 打开的管理器，浮在报告上方；关闭后报告仍在原处。
 *
 * 「选一次 → 做一件事 → 重新选」的循环，而不是一次性只读弹窗：改完开关要能立刻看到新
 * 状态。每一轮都重新取状态：server 崩溃后的懒重连、以及外部配置的改动都会改变它。
 */
export async function commandMcpsManager(host: McpCommandHost, managerPriority = 1): Promise<void> {
  const { ui, deps } = host;
  const childPriority = managerPriority + 1;
  // 服务取一次就够：插件不会在会话中途卸载，每轮迭代都判空只是噪音。
  // 但它**确实可能不存在**（`[plugins] disabled = ["sph-mcp"]`，或插件加载失败），
  // 那种情况必须如实说明——对着空清单说「0 个 server」会让人去查 server 配置，
  // 而真正的原因是提供 MCP 能力的插件根本没装。
  const service = deps.mcp();
  if (!service) {
      await showMessageDialog(ui, {
        priority: childPriority,
        title: 'MCP plugin not loaded',
      text: [
        'The `sph-mcp` plugin provides MCP support, and it is not loaded.',
        '',
        'Check `[plugins] disabled` in your config, and that the plugin exists at one of:',
        '  <sph install>/plugins/sph-mcp',
        '  ~/.sph/plugins/sph-mcp',
        '  <workspace>/plugins/sph-mcp',
        '',
        'Plugin load problems are printed at startup.',
      ].join('\n'),
      hint: 'Esc close',
      // 我们自己的清单：条目排成词项列（见 MarkdownOptions.termColumnLists）。
      termColumns: true,
      ...commandPanelOptions(ui),
    });
    return;
  }
  for (;;) {
    const servers = service.listServers();
    const choice = await showSelectDialog(ui, {
      // 顶栏只写名字（与 Skills/Help/Plugins 对齐）；数量挂在 Servers 组头上。
      title: 'MCP servers',
      maxVisible: 14,
      hint: 'Enter act · Esc close · click outside back to report',
      items: [
        // 动作与清单分组：组头与内联菜单统一显示 `✦ 名称 (数量)`。
        { value: 'hdr-actions', kind: 'header' as const, label: 'Actions', countNoun: 'actions' },
        { value: 'reload', label: 'Reload from disk', description: 're-read every source and reconnect' },
        { value: 'add', label: 'Add a server…', description: `append to ${deps.configPath}` },
        { value: 'hdr-servers', kind: 'header' as const, label: 'Servers', countNoun: 'servers' },
        ...servers.map((server) => ({
          value: `server:${server.name}`,
          label: mcpServerLabel(server),
          // 状态与来源放说明列：主列只剩名字，词项列对齐；target 这类细节点进动作菜单看。
          description: `${mcpStateLabel(server)} · from ${server.origin.label}`,
        })),
        ...(servers.length === 0
          ? [{ value: 'no-servers', kind: 'doc' as const, label: 'nothing configured yet — add one with the action above' }]
          : []),
      ],
      priority: managerPriority,
      onOutsidePress: () => undefined,
      ...commandPanelOptions(ui),
    });
    if (choice === undefined) return;
    if (choice === 'reload') {
      await reloadMcpWithNotice(host);
      continue;
    }
    if (choice === 'add') {
        await addMcpServer(host);
      continue;
    }
    await manageMcpServer(host, choice.slice(SERVER_PREFIX.length), childPriority);
  }
}

/**
 * 重载 MCP，并把结果讲清楚。
 *
 * 只说「已重载」等于没说：用户关心的是**哪个**连上了、哪个被关掉了。
 */
export async function reloadMcpWithNotice(host: McpCommandHost): Promise<void> {
  const { deps } = host;
  const result = await deps.reloadMcp();
  const parts: string[] = [];
  if (result.added.length > 0) parts.push(`+ ${result.added.join(', ')}`);
  if (result.restarted.length > 0) parts.push(`~ ${result.restarted.join(', ')}`);
  if (result.removed.length > 0) parts.push(`- ${result.removed.join(', ')}`);
  // 没变化就不出声：reload 的预期结果本来就是"什么都没变"，有变化才有值得报的名字。
  // 出错另有去处——下面那圈 warnings 照发。
  if (parts.length > 0) host.addNotice(`MCP: reloaded · ${parts.join(' · ')}`, 'dim');
  for (const warning of deps.mcp()?.warnings() ?? []) host.addNotice(warning, 'warn');
}

async function addMcpServer(host: McpCommandHost): Promise<void> {
  const { ui, deps } = host;
  const rawName = await showInputDialog(ui, {
    priority: 2,
    title: 'Server name',
    hint: 'letters, digits, - and _ · Esc cancel',
  });
  if (rawName === undefined) return;
  const name = rawName.trim();
  // 名字会进 TOML、也会成为工具命名空间，限制字符集比事后处理转义简单得多。
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    host.addNotice(`Invalid server name (letters, digits, - and _ only): ${name}`, 'warn');
    return;
  }
  const rawLine = await showInputDialog(ui, {
    priority: 2,
    title: `Command for ${name}`,
    hint: 'e.g. npx -y @modelcontextprotocol/server-filesystem . · quote paths with spaces',
  });
  if (rawLine === undefined) return;
  const parsed = splitCommandLine(rawLine.trim());
  if (parsed === undefined) {
    host.addNotice('Unbalanced quotes in that command — nothing written.', 'warn');
    return;
  }
  upsertSphMcpServer(deps.configPath, { name, command: parsed.command, args: parsed.args });
  host.addNotice(`Added ${name} to ${deps.configPath}`, 'success');
  await reloadMcpWithNotice(host);

  // 写进去却被项目级同名条目盖住是「设置不生效」的典型来源，必须当场说出来。
  const written = deps.mcp()?.listServers().find((server) => server.name === name);
  if (written !== undefined && written.origin.path !== deps.configPath) {
    host.addNotice(
      `${name} is overridden by ${written.origin.label} (closer/project config wins)`,
      'warn',
    );
  }
}

async function manageMcpServer(host: McpCommandHost, name: string, childPriority: number): Promise<void> {
  const { ui, deps } = host;
  const server = deps.mcp()?.listServers().find((item) => item.name === name);
  if (server === undefined) return; // 列表是上一轮取的，条目可能已经不在了
  type Action = { value: string; label: string; description?: string; tone?: 'danger' };
  const items: Action[] = [
    {
      value: 'toggle',
      label: server.enabled ? 'Disable' : 'Enable',
      // 定义就在 sph 配置里时直接改那一条；外部来源只读，改成写一条同名的禁用标记——
      // 同名整条替换，照样盖得住，而别人的文件一个字节都不动。
      description: server.origin.editable
        ? `edit ${server.origin.path}`
        : `override in ${deps.configPath} ([mcp_servers.${server.name}] disabled)`,
    },
  ];
  if (server.connected) {
    items.push({ value: 'tools', label: 'Show tools', description: `${server.tools.length} available` });
  }
  if (server.origin.editable) {
    items.push({ value: 'remove', label: 'Remove from config', description: server.origin.path, tone: 'danger' });
  }
  const action = await showSelectDialog(ui, {
    title: `${mcpServerLabel(server)} — ${mcpStateLabel(server)}`,
    // 状态型正文排成键值行（key-value 对齐靠空格，markdown 会折叠空格，所以走 plain）：
    // 散文句里键藏在语法里，键值行扫一眼就知道「哪个 server、配置来自哪」。
    bodyText: `server  ${server.target}\nsource  ${server.origin.label}`,
    bodyFormat: 'plain',
    items,
    maxVisible: 4,
    priority: childPriority,
    onOutsidePress: () => undefined,
    ...commandPanelOptions(ui),
  });

  if (action === 'toggle') {
    // 列表是上一轮取的，这里的 enabled 就是那一份快照：取反即本次要写的目标态。
    // 外部来源自己写了 disabled 时，启用必须落在 sph 配置里（别人的文件不写）。
    const target = server.origin.editable ? server.origin.path : deps.configPath;
    setSphMcpDisabled(target, server.name, server.enabled);
    await reloadMcpWithNotice(host);
    return;
  }
  if (action === 'tools') {
    await showMessageDialog(ui, {
      priority: childPriority + 1,
      title: `${mcpServerLabel(server)} tools`,
      text: renderMcpTools(server),
      hint: 'Esc close',
      ...commandPanelOptions(ui),
    });
    return;
  }
  if (action === 'remove') {
    // 危险确认：Remove 标红、焦点初始停在 Cancel——Enter 连按不会误删配置。
    const confirmed = await showConfirmDialog(ui, {
      priority: childPriority + 2,
      title: `Remove ${mcpServerLabel(server)}?`,
      message: `This deletes the entry from ${server.origin.path}. Nothing else is touched.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!confirmed) return;
    const removed = removeSphMcpServer(server.origin.path, server.name);
    // 「本来就不在」不出声：结果与"删掉了"对用户是同一件事。
    if (removed) host.addNotice(`Removed ${server.name} from ${server.origin.path}`, 'success');
    await reloadMcpWithNotice(host);
  }
}
