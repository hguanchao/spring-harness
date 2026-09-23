import type { PluginApi } from '../types.js';
import { grepTool } from './grep.js';
import { listDirTool } from './list-dir.js';
import { readFileTool } from './read-file.js';
import { searchReplaceTool } from './search-replace.js';
import { bashTool, pwshTool } from './shell.js';
import { skillTool } from './skill.js';
import { askUserTool } from './ask-user.js';
import { globTool } from './glob.js';
import { webFetchTool, webSearchTool } from './web-search.js';
import { jobsTool } from './jobs.js';
import type { ToolSpec } from '../../tools/types.js';
import { writeTool } from './write.js';
import { ToolRegistry } from '../../tools/registry.js';

function tagged(tool: ToolSpec, flags: Pick<ToolSpec, 'concurrencySafe' | 'explore' | 'rootOnly' | 'planSafe'>): ToolSpec {
  return { ...tool, ...flags };
}

/**
 * 默认产品工具表。标志写在装配处而不是每个工具文件里：漏标对照下面这份清单，
 * 不必在每个工具文件里搜三个布尔值。
 *
 * rootOnly 用于隔离子代理：只对根会话开放的工具（如 send_subagent_message）
 * 由 ToolRegistry.generalNames() 从子代理的工具集里剔除。
 */
export const tools: ToolSpec[] = [
  tagged(readFileTool, { concurrencySafe: true, explore: true, planSafe: true }),
  writeTool,
  searchReplaceTool,
  tagged(grepTool, { concurrencySafe: true, explore: true, planSafe: true }),
  tagged(globTool, { concurrencySafe: true, explore: true, planSafe: true }),
  tagged(listDirTool, { concurrencySafe: true, explore: true, planSafe: true }),
  bashTool,
  pwshTool,
  tagged(skillTool, { concurrencySafe: true, explore: true, planSafe: true }),
  tagged(askUserTool, { explore: true, planSafe: true }),
  tagged(webSearchTool, { concurrencySafe: true, explore: true, planSafe: true }),
  tagged(jobsTool, { concurrencySafe: true, planSafe: true }),
  tagged(webFetchTool, { concurrencySafe: true, explore: true, planSafe: true }),
];

function createDefaultToolRegistry(): ToolRegistry {
  return new ToolRegistry(tools);
}

export const defaultTools = createDefaultToolRegistry();

/** 未知工具 fail-closed：不当成只读。 */
export function isConcurrencySafe(name: string): boolean {
  return defaultTools.isConcurrencySafe(name);
}

/** 插件入口。核心工具表是空的，读、写、搜索、shell 都从这里挂上。 */
export default function setup(api: PluginApi): void {
  for (const tool of tools) api.registerTool(tool);
}

export const EXPLORE_TOOLS = defaultTools.exploreNames();

export { ToolRegistry } from '../../tools/registry.js';
export type { OpenAiTool } from '../../tools/registry.js';
