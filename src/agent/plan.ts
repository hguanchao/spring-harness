/**
 * Plan mode：先探索再动手。
 *
 * 激活期间系统提示词多一段引导，写工具（含 shell / 可写 subagent）被运行时拒绝。
 * 模型用 exit_plan_mode 呈交完整 markdown 计划，用户批准后才离开。
 * 状态只记一条 last-wins 的 `plan_mode` 事件，resume 从日志折叠。
 */
import { join } from 'node:path';

/** 计划模式里禁止的副作用工具。explore 子代理除外，由调用方单独放行。 */
export const PLAN_BLOCKED_TOOLS = new Set([
  'write',
  'search_replace',
  'shell',
  'mcp',
  'subagent',
  'send_subagent_message',
]);

export function planFilePath(sessionDir: string, sessionId: string): string {
  return join(sessionDir, `${sessionId}.plan.md`);
}

/** 计划必须以一级标题开头（dsh exit_plan_mode 同约束），否则评审没有名字。 */
export function hasPlanHeading(plan: string): boolean {
  return /^#\s+\S/.test(plan.trim());
}

/** 取第一行 ATX 标题，作评审弹窗标题。 */
export function planHeading(plan: string): string | undefined {
  for (const line of plan.split('\n')) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (match) return match[1].trim();
  }
  return undefined;
}

export function planModeSection(): string {
  return [
    '<plan_mode>',
    'You are in plan mode: explore the codebase and design an implementation plan. Do not implement.',
    'Use read_file, grep, glob, list_dir, ask_user, todo, skill, web_search, jobs, and explore subagents.',
    'Writes, search_replace, shell, mcp, general subagents, and send_subagent_message are blocked until the user approves the plan.',
    'When the plan is complete, call exit_plan_mode with the FULL markdown, starting with a # heading that names it.',
    'If the user asks you to write a plan or the approach is still ambiguous, stay here until they approve.',
    '</plan_mode>',
  ].join('\n');
}

export function planBlockedReason(name: string): string {
  return `blocked in plan mode: ${name}. Explore and present a plan via exit_plan_mode; implementation waits for approval.`;
}
