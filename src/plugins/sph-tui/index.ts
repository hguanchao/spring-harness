/**
 * TUI 进程入口。
 *
 * 外面只拿到启动交互和信任确认。控件在 src/tui（经 `@/*` 别名引用），这里不再转出。
 * createScreen 是例外：信任页要先占住备用屏幕，主界面接手同一块，所以创建权在调用方。
 *
 * 静态依赖按「信任页先到」排布，两条路径的加载成本差一个数量级：
 *   - 信任页只要 createScreen + confirmWorkspaceTrust，控件层取深路径，不吃整层；
 *   - 主界面栈（interactive-mode 会拉进转录、命令域、全部消息/工具块）改为在 run() 里
 *     动态加载——静态引进来会让一屏 logo + y/n 先等整个界面栈就绪。
 * 因此 runTui 不再值导出；`TuiDeps` 是类型导出，编译期擦除，不构成运行时依赖。
 * 备用屏幕的外观按同一条线切：信任页只见 chrome.ts 的画布色，主界面的吸顶叠层在
 * transcript-chrome.ts。
 */

import type { CliArgs } from '@/cli/args.js';
import { sphSpillRoot } from '@/home.js';
import type { Runtime } from '@/cli/bootstrap.js';
import { UI_SERVICE, type UiService } from '@/plugins/services.js';
import type { PluginApi } from '@/plugins/types.js';
import type { ViewportTUI } from '@/tui/screen/tui.js';

export type { TuiDeps } from '@/plugins/sph-tui/deps.js';

/**
 * 信任页的备用屏幕。调用方 start 一次，结束时 stop。
 *
 * 只挂画布色（`canvasOptions`），不挂主界面的吸顶叠层：这一屏没有转录，吸顶无处可贴。
 * 屏幕实现按需加载：插件 setup 只登记服务，不把 TuiAltScreen / 主题 / 信任页静态拉进来。
 */
export async function createScreen(workspaceRoot: string): Promise<ViewportTUI> {
  const [{ canvasOptions }, { TuiAltScreen }, { ProcessTerminal }] = await Promise.all([
    import('@/plugins/sph-tui/chrome.js'),
    import('@/tui/screen/tui-alt-screen.js'),
    import('@/tui/terminal/terminal.js'),
  ]);
  return new TuiAltScreen(new ProcessTerminal(), false, workspaceRoot, canvasOptions);
}

const ui: UiService = {
  async confirmTrust(workspaceRoot) {
    const [{ confirmWorkspaceTrust }, screen] = await Promise.all([
      import('@/plugins/sph-tui/trust/index.js'),
      createScreen(workspaceRoot),
    ]);
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
    const { runTui } = await import('@/plugins/sph-tui/interactive-mode.js');
    await runTui({
      workspaceRoot: rt.workspaceRoot,
      sessionDir: rt.sessionDir,
      contextWindow: rt.config.contextWindow,
      sandbox: rt.sandbox,
      session: rt.session,
      mcp: () => rt.mcp(),
      reloadMcp: () => rt.reloadMcp(),
      pluginReport: () => rt.plugins.report(),
      pluginServices: rt.plugins,
      pluginCommands: rt.plugins.commands(),
      turnListeners: rt.plugins.turnListeners(),
      todos: rt.todos,
      jobs: rt.jobs,
      approvalMode: cli.approval ?? rt.config.approval ?? 'ask',
      notify: rt.config.notify,
      notifyAfterSeconds: rt.config.notifyAfterSeconds,
      permission: rt.permission,
      subagentApproval: rt.config.subagentApproval,
      configPath: rt.configPath,
      authLabel: rt.config.startupWarnings.length > 0
        ? 'Model pointer needs fixing — open /provider'
        : rt.config.apiKey === ''
          ? 'Logged in with HTTP headers'
          : 'Logged in with API key',
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
      maxTurns: rt.config.maxTurns,
      maxSessionTokens: rt.config.maxSessionTokens,
      worktrees: rt.worktrees,
      tools: rt.tools,
      sessions: rt.sessions,
      driver: rt.driver,
      claimSession: (id) => rt.claimSession(id),
      startupWarnings: rt.config.startupWarnings,
    });
  },
};

/** 插件入口。交互界面从这里挂上，宿主只调用服务。 */
export default function setup(api: PluginApi): void {
  api.provide(UI_SERVICE, ui);
}
