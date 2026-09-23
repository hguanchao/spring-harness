/**
 * sph-subagent：把委托做成内置插件。
 *
 * 代理定义和两个工具在插件里，子会话仍由宿主跑。
 * 关掉本插件，工具表里不再有 subagent / send_subagent_message，
 * loop 里的深度预算和事件协议留在原地，只是再也没人调用它们。
 *
 * 定义每次调用重新读：用户往 `.sph/agents/` 丢一份文件后，下一轮就能用，不必重启。
 */
import { SUBAGENT_SERVICE, type SubagentCatalog } from '../services.js';
import type { PluginApi } from '../types.js';
import { discoverAgents, findAgent } from './agents.js';
import { createSubagentTool, sendSubagentMessageTool } from './tool.js';

/** 插件入口。宿主按 `src/plugins/sph-subagent/` 装载，插件名取目录名。 */
export default function setup(api: PluginApi): void {
  const agents = () => discoverAgents(api.workspaceRoot, api.host.isWorkspaceTrusted(api.workspaceRoot));
  const catalog: SubagentCatalog = {
    find(name) {
      const agent = findAgent(agents(), name);
      return agent ? { writes: agent.writes } : undefined;
    },
  };
  api.registerTool(createSubagentTool(agents));
  api.registerTool(sendSubagentMessageTool);
  api.provide(SUBAGENT_SERVICE, catalog);
}
