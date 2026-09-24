/**
 * 一次工具调用能不能执行。
 *
 * 循环只按模型顺序提交结果。允许、计划模式、未知工具都在这里判定，
 * 新工具注册进来不必再改循环。
 */
import type { PlanModeSeam } from '../plugins/services.js';
import type { ToolRegistry } from './registry.js';

export function toolDenied(
  registry: ToolRegistry,
  name: string,
  args: Record<string, unknown>,
  options: {
    allowed?: ReadonlySet<string>;
    depth: number;
    planMode?: boolean;
    plan?: PlanModeSeam;
  },
): string | undefined {
  if (options.allowed && !options.allowed.has(name)) return `tool not allowed in this agent: ${name}`;
  if (registry.isRootOnly(name) && options.depth > 0) return `tool only available to the root session: ${name}`;
  if (!registry.find(name)) return `unknown tool: ${name}`;
  if (options.planMode) {
    // 插件可以按参数覆盖（只读子代理放行）。没有覆盖时按工具自己的 planSafe，
    // 未声明即拦截：新注册的写工具不会因为不在某张名单里而被放开。
    const verdict = options.plan?.isBlocked(name, args);
    const blocked = verdict === true || (verdict !== false && !registry.isPlanSafe(name));
    if (blocked) return options.plan?.blockedReason(name) ?? `blocked in plan mode: ${name}`;
  }
  return undefined;
}
