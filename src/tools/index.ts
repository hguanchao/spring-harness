import { grepTool } from './grep.js';
import { listDirTool } from './list-dir.js';
import { readFileTool } from './read-file.js';
import { searchReplaceTool } from './search-replace.js';
import { bashTool, pwshTool } from './shell.js';
import { skillTool } from './skill.js';
import { todoTool } from './todo.js';
import { askUserTool } from './ask-user.js';
import { globTool } from './glob.js';
import { webFetchTool, webSearchTool } from './web-search.js';
import { jobsTool } from './jobs.js';
import { subagentTool } from './subagent.js';
import { sendSubagentMessageTool } from './send-subagent.js';
import type { ToolSpec } from './types.js';
import { enterPlanModeTool, exitPlanModeTool } from './plan.js';
import { writeTool } from './write.js';
import { ToolRegistry } from './registry.js';

function tagged(tool: ToolSpec, flags: Pick<ToolSpec, 'concurrencySafe' | 'explore' | 'rootOnly'>): ToolSpec {
  return { ...tool, ...flags };
}

/**
 * 默认产品工具表。标志写在装配处而不是每个工具文件里：漏标对照下面这份清单，
 * 不必在每个工具文件里搜三个布尔值。
 *
 * rootOnly 用于隔离子代理：send_subagent_message 这类工具若对子代理开放，
 * 会形成无主的旁路通道。子代理的 allowedTools 由 ToolRegistry.generalNames() 剔除。
 */
export const tools: ToolSpec[] = [
  tagged(readFileTool, { concurrencySafe: true, explore: true }),
  writeTool,
  searchReplaceTool,
  tagged(grepTool, { concurrencySafe: true, explore: true }),
  tagged(globTool, { concurrencySafe: true, explore: true }),
  tagged(listDirTool, { concurrencySafe: true, explore: true }),
  bashTool,
  pwshTool,
  tagged(skillTool, { concurrencySafe: true, explore: true }),
  tagged(todoTool, { explore: true }),
  tagged(askUserTool, { explore: true }),
  tagged(webSearchTool, { concurrencySafe: true, explore: true }),
  tagged(jobsTool, { concurrencySafe: true }),
  tagged(subagentTool, { concurrencySafe: true }),
  tagged(sendSubagentMessageTool, { rootOnly: true }),
  tagged(enterPlanModeTool, { rootOnly: true }),
  tagged(exitPlanModeTool, { rootOnly: true }),
  tagged(webFetchTool, { concurrencySafe: true, explore: true }),
];

function createDefaultToolRegistry(): ToolRegistry {
  return new ToolRegistry(tools);
}

export const defaultTools = createDefaultToolRegistry();

/** 未知工具 fail-closed：不当成只读。 */
export function isConcurrencySafe(name: string): boolean {
  return defaultTools.isConcurrencySafe(name);
}

export const EXPLORE_TOOLS = defaultTools.exploreNames();

export { ToolRegistry } from './registry.js';
export type { OpenAiTool } from './registry.js';
