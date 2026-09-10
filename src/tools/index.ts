import { grepTool } from './grep.js';
import { listDirTool } from './list-dir.js';
import { readFileTool } from './read-file.js';
import { searchReplaceTool } from './search-replace.js';
import { shellTool } from './shell.js';
import { skillTool } from './skill.js';
import { todoTool } from './todo.js';
import { askUserTool } from './ask-user.js';
import { exitPlanModeTool } from './exit-plan.js';
import { webFetchTool } from './web-fetch.js';
import { jobsTool } from './jobs.js';
import { subagentTool } from './subagent.js';
import { mcpTool } from './mcp.js';
import type { ToolSpec } from './types.js';
import { writeTool } from './write.js';

export const tools: ToolSpec[] = [
  readFileTool,
  writeTool,
  searchReplaceTool,
  grepTool,
  listDirTool,
  shellTool,
  skillTool,
  todoTool,
  askUserTool,
  exitPlanModeTool,
  webFetchTool,
  jobsTool,
  subagentTool,
  mcpTool,
];

export const READ_TOOLS = new Set(['read_file', 'grep', 'list_dir', 'skill', 'todo', 'jobs']);
export const EXPLORE_TOOLS = new Set([
  'read_file', 'grep', 'list_dir', 'skill', 'web_fetch', 'ask_user', 'todo',
]);
/** plan mode 白名单：纯只读调研 + 计划提交。 */
export const PLAN_TOOLS = new Set(['read_file', 'grep', 'list_dir', 'skill', 'todo', 'ask_user', 'exit_plan_mode']);

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
