import { sphHome } from '../home.js';
import type { SkillEntry } from '../skills/scan.js';
import type { SandboxMode } from '../sandbox/types.js';
import type { McpTool } from '../mcp/hub.js';
import { loadMemory, memoryToPrompt } from './memory.js';

/** 沙箱能力的真实边界必须在提示词里说清：模型据此决定是否绕过限制。 */
function sandboxLine(mode: SandboxMode): string {
  if (mode === 'off') return 'Sandbox: off (no OS confinement).';
  if (process.platform === 'win32') {
    return `Sandbox: ${mode} on Windows (partial: restricted token + ACL; reads/network/hardlinks not confined).`;
  }
  if (process.platform === 'linux') return `Sandbox: ${mode} on Linux (partial: bwrap bind mounts).`;
  return `Sandbox: ${mode} is unsupported on this OS; startup should have failed.`;
}

export function buildSystemPrompt(input: {
  workspaceRoot: string;
  sandbox: SandboxMode;
  skills: SkillEntry[];
  mcpTools?: McpTool[];
  persistent?: string;
  planMode?: boolean;
  /** 跨轮次任务目标（会话事件折叠而来）。 */
  goal?: string;
  /** 最近一次工具失败；恢复会话后尤其有用。 */
  lastFailure?: { tool: string; excerpt: string };
}): string {
  const memory = memoryToPrompt(loadMemory(input.workspaceRoot, sphHome()));
  const catalog = input.skills.length === 0
    ? '(none)'
    : input.skills.map((skill) => `- ${skill.name}: ${skill.description} [${skill.path}]`).join('\n');
  const mcp = !input.mcpTools || input.mcpTools.length === 0
    ? '(none)'
    : input.mcpTools.map((tool) => `- ${tool.server}/${tool.name}: ${tool.description}`).join('\n');
  const planLine = input.planMode
    ? [
        'PLAN MODE IS ACTIVE: research and design only.',
        'Read files, search, and ask the user; writing and shell are blocked.',
        'When the plan is concrete (goal, file-level steps, verification), call exit_plan_mode with it.',
        'If your plan is rejected, revise it from the feedback — do not try to implement around the block.',
      ].join('\n')
    : '';
  // 目标与失败历史来自会话事件，是「跨轮次」状态——压缩之后仍要看得见，所以放在提示词里。
  const goalLine = input.goal
    ? `Current goal (persisted across turns until the user clears it):\n${input.goal}`
    : '';
  const failureLine = input.lastFailure
    ? `Most recent tool failure in this session:\n${input.lastFailure.tool}: ${input.lastFailure.excerpt}\nDo not repeat it blindly; re-read the error before retrying the same call.`
    : '';
  return [
    'You are Spring Harness (sph), a general-purpose agent running on the user machine.',
    `Workspace root: ${input.workspaceRoot}`,
    sandboxLine(input.sandbox),
    `Persistent shell mode: ${input.persistent ?? 'confined-oneshot'}.`,
    'Tools: read_file, write, search_replace, grep, list_dir, shell, skill, todo, ask_user, exit_plan_mode, web_fetch, jobs, subagent, mcp.',
    'Use search_replace for edits. write is for new files or full rewrites.',
    'shell is PowerShell (pwsh) on Windows, sh on Unix. cwd is the workspace root.',
    'Use skill(name) to load a SKILL.md. Catalog is name + description only.',
    'Use todo to keep a short in-session checklist. Use jobs for long shell work. Use subagent to fan out read-heavy work (explore is read-only, background subagents are pollable via jobs).',
    'web_fetch is HTTP GET only — no search engine. mcp lists/calls stdio MCP servers from config.',
    'user messages appearing between tool batches are the user steering mid-run — honor them.',
    'Stay inside the workspace. Do not escape with .. or other drives.',
    goalLine,
    failureLine,
    `Skill catalog:\n${catalog}`,
    `MCP tools:\n${mcp}`,
    memory ? `Project instructions:\n${memory}` : 'No AGENTS.md at workspace root.',
    planLine,
  ].filter(Boolean).join('\n\n');
}
