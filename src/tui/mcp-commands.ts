/**
 * `/mcps` 命令域：MCP server 的查看、启停、增删与重载。
 *
 * 弹窗交互 + 配置写回（config/mcp-write）+ 经宿主重载。宿主只需要提供 ui、deps 与
 * 通知行——这一域不触碰会话与轮次状态，是命令里最独立的一块。
 */

import { removeSphMcpServer, setSphMcpPreference, splitCommandLine, upsertSphMcpServer } from '../config/mcp-write.js';
import type { TUI } from './core/index.js';
import type { TuiDeps } from './deps.js';
import { showConfirmDialog, showInputDialog, showMessageDialog, showSelectDialog } from './dialogs.js';
import { mcpStateLabel, renderMcpReport, renderMcpTools } from './reports.js';
import { SERVER_PREFIX } from './commands.js';

/** MCP 命令需要的宿主能力。 */
export interface McpCommandHost {
  ui: TUI;
  deps: TuiDeps;
  addNotice(text: string, level?: 'dim' | 'warn' | 'error' | 'success'): void;
}

/**
 * MCP 管理器。
 *
 * 「选一次 → 做一件事 → 重新选」的循环，而不是一次性只读弹窗：改完开关要能立刻看到新
 * 状态，否则用户只能反复敲命令来确认刚才那一下到底生效没有。Esc 退出。
 *
 * 每一轮都重新取状态：server 崩溃后的懒重连、以及外部配置的改动都会改变它。
 */
export async function commandMcps(host: McpCommandHost): Promise<void> {
  const { ui, deps } = host;
  for (;;) {
    const servers = deps.mcp.listServers();
    const choice = await showSelectDialog(ui, {
      title: `MCP servers (${servers.length})`,
      maxVisible: 14,
      hint: 'Enter act · Esc close',
      items: [
        { value: 'reload', label: 'Reload from disk', description: 're-read every source and reconnect' },
        { value: 'report', label: 'Show full report', description: 'sources scanned, warnings, per-server tools' },
        { value: 'add', label: 'Add a server…', description: `append to ${deps.configPath}` },
        ...servers.map((server) => ({
          value: `server:${server.name}`,
          label: `${server.name} — ${mcpStateLabel(server)}`,
          description: `${server.target} · from ${server.origin.label}`,
        })),
      ],
    });
    if (choice === undefined) return;
    if (choice === 'report') {
      await showMessageDialog(ui, {
        title: 'MCP servers',
        text: renderMcpReport({
          servers: deps.mcp.listServers(),
          warnings: [...(deps.mcpWarnings ?? [])],
          sources: [...deps.mcpSources()],
        }),
        hint: 'Esc close · status is live',
      });
      continue;
    }
    if (choice === 'reload') {
      await reloadMcpWithNotice(host);
      continue;
    }
    if (choice === 'add') {
      await addMcpServer(host);
      continue;
    }
    await manageMcpServer(host, choice.slice(SERVER_PREFIX.length));
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
  host.addNotice(
    parts.length === 0 ? 'MCP: reloaded, nothing changed' : `MCP: reloaded · ${parts.join(' · ')}`,
    'dim',
  );
  for (const warning of deps.mcpWarnings ?? []) host.addNotice(warning, 'warn');
}

async function addMcpServer(host: McpCommandHost): Promise<void> {
  const { ui, deps } = host;
  const rawName = await showInputDialog(ui, {
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
  const written = deps.mcp.listServers().find((server) => server.name === name);
  if (written !== undefined && written.origin.path !== deps.configPath) {
    host.addNotice(
      `${name} is overridden by ${written.origin.label} (closer/project config wins)`,
      'warn',
    );
  }
}

async function manageMcpServer(host: McpCommandHost, name: string): Promise<void> {
  const { ui, deps } = host;
  const server = deps.mcp.listServers().find((item) => item.name === name);
  if (server === undefined) return; // 列表是上一轮取的，条目可能已经不在了
  type Action = { value: string; label: string; description?: string };
  const items: Action[] = [
    {
      value: 'toggle',
      label: server.enabled ? 'Disable' : 'Enable',
      // 外部来源只读，开关记在 sph 自己的配置里——写别人的文件是不可逆的副作用。
      description: server.origin.editable
        ? `edit ${server.origin.path}`
        : `recorded in ${deps.configPath} as a local preference`,
    },
  ];
  if (server.connected) {
    items.push({ value: 'tools', label: 'Show tools', description: `${server.tools.length} available` });
  }
  if (server.origin.editable) {
    items.push({ value: 'remove', label: 'Remove from config', description: server.origin.path });
  }
  const action = await showSelectDialog(ui, {
    title: `${server.name} — ${mcpStateLabel(server)}`,
    bodyText: `${server.target}\nfrom ${server.origin.label}`,
    items,
    maxVisible: 4,
  });

  if (action === 'toggle') {
    const enabled = !server.enabled;
    setSphMcpPreference(deps.configPath, server.name, {
      enabled,
      sourceEnabled: server.sourceEnabled ?? server.enabled,
    });
    deps.refreshMcpPreferences();
    await reloadMcpWithNotice(host);
    return;
  }
  if (action === 'tools') {
    await showMessageDialog(ui, {
      title: `${server.name} tools`,
      text: renderMcpTools(server),
      hint: 'Esc close',
    });
    return;
  }
  if (action === 'remove') {
    const confirmed = await showConfirmDialog(ui, {
      title: `Remove ${server.name}?`,
      message: `This deletes the entry from ${server.origin.path}. Nothing else is touched.`,
      confirmLabel: 'Remove',
    });
    if (!confirmed) return;
    const removed = removeSphMcpServer(server.origin.path, server.name);
    host.addNotice(
      removed ? `Removed ${server.name} from ${server.origin.path}` : `${server.name} was already gone`,
      removed ? 'success' : 'warn',
    );
    // 名字没了，可能还留着一条只认识它的本地偏好；留着会在同名条目重新出现时突然生效。
    setSphMcpPreference(deps.configPath, server.name, { enabled: true, sourceEnabled: true });
    deps.refreshMcpPreferences();
    await reloadMcpWithNotice(host);
  }
}
