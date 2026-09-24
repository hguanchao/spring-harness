/**
 * sph-subagent：把委托做成内置插件。
 *
 * 代理定义和两个工具在插件里，子会话仍由宿主跑。
 * 关掉本插件，工具表里不再有 task / send_subagent_message，
 * loop 里的深度预算和事件协议留在原地，只是再也没人调用它们。
 *
 * 定义每次调用重新读：用户往 `.sph/agents/` 丢一份文件后，下一轮就能用，不必重启。
 */
import { SUBAGENT_SERVICE, type SubagentCatalog } from '../services.js';
import type { PluginApi } from '../types.js';
import { discoverAgents, findAgent, resolveAgentTools } from './agents.js';
import { ToolRegistry } from '../../tools/registry.js';
import { registerAgentCommand } from './command.js';
import { createTaskTool, sendSubagentMessageTool } from './tool.js';

/** 插件入口。宿主按 `src/plugins/sph-subagent/` 装载，插件名取目录名。 */
export default function setup(api: PluginApi): void {
  const agents = () => discoverAgents(api.workspaceRoot, api.host.isWorkspaceTrusted(api.workspaceRoot));
  const catalog: SubagentCatalog = {
    find(name) {
      const agent = findAgent(agents(), name);
      return agent ? { writes: agent.writes } : undefined;
    },
    seat(name) {
      const agent = findAgent(agents(), name);
      if (!agent) return undefined;
      // 此刻工具表还在装。seat 在一轮开始时才调用，那时宿主的表已经完整。
      const listed = api.consume<readonly import('../../tools/types.js').ToolSpec[]>('sph-tool-list');
      if (!listed) return undefined;
      return { tools: resolveAgentTools(agent, new ToolRegistry([...listed])), prompt: agent.systemPrompt };
    },
  };
  api.registerTool(createTaskTool(agents));
  api.registerTool(sendSubagentMessageTool);
  registerAgentCommand(api);
  api.provide(SUBAGENT_SERVICE, catalog);
}
