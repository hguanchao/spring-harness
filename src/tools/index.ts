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
import { ToolRegistry } from './registry.js';

function tagged(tool: ToolSpec, flags: Pick<ToolSpec, 'concurrencySafe' | 'explore' | 'rootOnly'>): ToolSpec {
  return { ...tool, ...flags };
}

/**
 * 默认产品工具表。标志写在装配处而不是每个工具文件里：漏标对照下面这份清单，
 * 不必在 17 个文件里搜三个布尔值。
 */
export const tools: ToolSpec[] = [
  tagged(readFileTool, { concurrencySafe: true, explore: true }),
  writeTool,
  searchReplaceTool,
  tagged(grepTool, { concurrencySafe: true, explore: true }),
  tagged(globTool, { concurrencySafe: true, explore: true }),
  tagged(listDirTool, { concurrencySafe: true, explore: true }),
  shellTool,
  tagged(skillTool, { concurrencySafe: true, explore: true }),
  tagged(todoTool, { explore: true }),
  tagged(askUserTool, { explore: true }),
  tagged(webSearchTool, { concurrencySafe: true, explore: true }),
  tagged(jobsTool, { concurrencySafe: true }),
  tagged(subagentTool, { concurrencySafe: true }),
  tagged(sendSubagentMessageTool, { rootOnly: true }),
  mcpTool,
  tagged(enterPlanModeTool, { rootOnly: true }),
  tagged(exitPlanModeTool, { rootOnly: true }),
];

export function createDefaultToolRegistry(): ToolRegistry {
  return new ToolRegistry(tools);
}

export const defaultTools = createDefaultToolRegistry();

/** 未知工具 fail-closed：不当成只读。 */
export function isConcurrencySafe(name: string): boolean {
  return defaultTools.isConcurrencySafe(name);
}

export const EXPLORE_TOOLS = defaultTools.exploreNames();

/**
 * 仅根会话可见的工具（grok 的 send_subagent_message 同语义）：子代理互相发消息
 * 会形成无主的旁路通道。运行时为 general 子代理构建 allowedTools 时剔除，
 * denyReason 兜底双保险。
 */
export const ROOT_ONLY_TOOLS = new Set(
  tools.filter((tool) => tool.rootOnly).map((tool) => tool.name),
);

export function openaiTools(allowed?: ReadonlySet<string>) {
  return defaultTools.schemas(allowed);
}

export function findTool(name: string): ToolSpec | undefined {
  return defaultTools.find(name);
}

export { ToolRegistry } from './registry.js';
export type { OpenAiTool } from './registry.js';
