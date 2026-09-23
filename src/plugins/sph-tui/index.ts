/**
 * TUI 进程入口。
 *
 * 外面只拿到启动交互和信任确认。控件在 src/tui，由包导出 `./tui` 提供；这里不再转出。
 * createScreen 是例外：信任页要先占住备用屏幕，主界面接手同一块，所以创建权在调用方。
 */

import type { CliArgs } from '../../cli/args.js';
import { sphSpillRoot } from '../../home.js';
import type { Runtime } from '../../cli/bootstrap.js';
import { UI_SERVICE, type UiService } from '../services.js';
import type { PluginApi } from '../types.js';
import { productScreenOptions } from './chrome.js';
import { runTui } from './interactive-mode.js';
import { ProcessTerminal, TuiAltScreen, type ViewportTUI } from '../../tui/index.js';
import { confirmWorkspaceTrust } from './trust.js';

export { runTui, type TuiDeps } from './interactive-mode.js';
export { confirmWorkspaceTrust } from './trust.js';

/** 信任页与主界面共用的备用屏幕。调用方 start 一次，结束时 stop。 */
export function createScreen(workspaceRoot: string): ViewportTUI {
  return new TuiAltScreen(new ProcessTerminal(), false, workspaceRoot, productScreenOptions());
}

const ui: UiService = {
  async confirmTrust(workspaceRoot) {
    const screen = createScreen(workspaceRoot);
    try {
      const decision = confirmWorkspaceTrust(workspaceRoot, screen);
      screen.start();
      return await decision;
    } finally {
      screen.stop({ preserveScreen: true });
    }
  },
  async run(runtime, args) {
    const rt = runtime as Runtime;
    const cli = args as CliArgs;
    await runTui({
      workspaceRoot: rt.workspaceRoot,
      sessionDir: rt.sessionDir,
      contextWindow: rt.config.contextWindow,
      sandbox: rt.sandbox,
      session: rt.session,
      mcp: () => rt.mcp(),
      reloadMcp: () => rt.reloadMcp(),
      refreshMcpPreferences: () => rt.refreshMcpPreferences(),
      mcpPreferences: rt.mcpPreferences,
      pluginReport: () => rt.plugins.report(),
      pluginServices: rt.plugins,
      pluginCommands: rt.plugins.commands(),
      turnListeners: rt.plugins.turnListeners(),
      todos: rt.todos,
      jobs: rt.jobs,
      approvalMode: cli.approval ?? rt.config.approval ?? 'ask',
      permissionRules: rt.config.permissions,
      subagentApproval: rt.config.subagentApproval,
      configPath: rt.configPath,
      authLabel: rt.config.apiKey === '' ? 'Logged in with HTTP headers' : 'Logged in with API key',
      providerName: rt.config.provider,
      models: () => rt.registry.providers,
      resolveModel: (model, provider) => rt.resolveModel({ model, provider }),
      model: rt.config.model,
      effort: cli.effort ?? rt.config.reasoningEffort,
      maxTokens: cli.maxTokens ?? rt.config.maxTokens,
      makeClient: (overrides) => rt.makeClient(overrides),
      makeAuxClient: (model) => rt.makeAuxClient(model),
      modelPinned: cli.model !== undefined,
      compactModel: rt.config.compactModel,
      reviewModel: rt.config.reviewModel,
      spillRoot: sphSpillRoot(),
      spillThreshold: rt.config.spillThreshold,
      maxSubagentDepth: rt.config.subagentMaxDepth,
      maxSessionTokens: rt.config.maxSessionTokens,
      worktrees: rt.worktrees,
      tools: rt.tools,
      sessions: rt.sessions,
      driver: rt.driver,
      claimSession: (id) => rt.claimSession(id),
    });
  },
};

/** 插件入口。交互界面从这里挂上，宿主只调用服务。 */
export default function setup(api: PluginApi): void {
  api.provide(UI_SERVICE, ui);
}
