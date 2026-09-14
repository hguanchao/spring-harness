import { grepTool } from './grep.js';
import { listDirTool } from './list-dir.js';
import { readFileTool } from './read-file.js';
import { searchReplaceTool } from './search-replace.js';
import { shellTool } from './shell.js';
import { skillTool } from './skill.js';
import { todoTool } from './todo.js';
import { askUserTool } from './ask-user.js';
import { webFetchTool } from './web-fetch.js';
import { jobsTool } from './jobs.js';
import { subagentTool } from './subagent.js';
import { sendSubagentMessageTool } from './send-subagent.js';
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
  webFetchTool,
  jobsTool,
  subagentTool,
  sendSubagentMessageTool,
  mcpTool,
];

/**
 * 只读/无副作用工具：同一回复里的多个调用用 Promise.all 并行执行。
 * subagent 在此集合里——同一回复的多个前台 task 才会真并行（各受 SUBAGENT_CONCURRENCY 并发信号量约束），
 * 且全部返回后才进入下一轮 LLM，保证「子代理跑完再总结」。
 */
export const READ_TOOLS = new Set(['read_file', 'grep', 'list_dir', 'skill', 'todo', 'jobs', 'subagent']);
export const EXPLORE_TOOLS = new Set([
  'read_file', 'grep', 'list_dir', 'skill', 'web_fetch', 'ask_user', 'todo',
]);
/**
 * 仅根会话可见的工具（grok 的 send_subagent_message 同语义）：子代理互相发消息
 * 会形成无主的旁路通道。运行时为 general 子代理构建 allowedTools 时剔除，
 * denyReason 兜底双保险。
 */
export const ROOT_ONLY_TOOLS = new Set(['send_subagent_message']);

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
