import { grepTool } from './grep.js';
import { listDirTool } from './list-dir.js';
import { readFileTool } from './read-file.js';
import { searchReplaceTool } from './search-replace.js';
import { shellTool } from './shell.js';
import { skillTool } from './skill.js';
import { todoTool } from './todo.js';
import { askUserTool } from './ask-user.js';
import { globTool } from './glob.js';
import { webSearchTool } from './web-search.js';
import { jobsTool } from './jobs.js';
import { subagentTool } from './subagent.js';
import { sendSubagentMessageTool } from './send-subagent.js';
import { mcpTool } from './mcp.js';
import type { ToolSpec } from './types.js';
import { enterPlanModeTool, exitPlanModeTool } from './plan.js';
import { writeTool } from './write.js';

export const tools: ToolSpec[] = [
  readFileTool,
  writeTool,
  searchReplaceTool,
  grepTool,
  globTool,
  listDirTool,
  shellTool,
  skillTool,
  todoTool,
  askUserTool,
  webSearchTool,
  jobsTool,
  subagentTool,
  sendSubagentMessageTool,
  mcpTool,
  enterPlanModeTool,
  exitPlanModeTool,
];

/**
 * 同一步可并行的工具。缺省 exclusive（未知名字、写工具、todo、mcp、ask）。
 * subagent 在此集合里——同一回复的多个前台 task 才会真并行（各受 SUBAGENT_CONCURRENCY 约束）。
 */
const PARALLEL_TOOLS = new Set([
  'read_file', 'grep', 'glob', 'list_dir', 'skill', 'jobs', 'web_search', 'subagent',
]);

/** 未知工具 fail-closed：不当成只读。 */
export function isConcurrencySafe(name: string): boolean {
  return PARALLEL_TOOLS.has(name);
}
export const EXPLORE_TOOLS = new Set([
  'read_file', 'grep', 'glob', 'list_dir', 'skill', 'web_search', 'ask_user', 'todo',
]);
/**
 * 仅根会话可见的工具（grok 的 send_subagent_message 同语义）：子代理互相发消息
 * 会形成无主的旁路通道。运行时为 general 子代理构建 allowedTools 时剔除，
 * denyReason 兜底双保险。
 */
export const ROOT_ONLY_TOOLS = new Set(['send_subagent_message', 'enter_plan_mode', 'exit_plan_mode']);

export function openaiTools(allowed?: ReadonlySet<string>): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return tools
    .filter((tool) => !allowed || allowed.has(tool.name))
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.schema,
      },
    }));
}

/** 名字 → 工具的索引。工具面按名字查，每个 tool call 都走一次，建表避免线性扫描。 */
const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

export function findTool(name: string): ToolSpec | undefined {
  return toolsByName.get(name);
}
