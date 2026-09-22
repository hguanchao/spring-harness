/**
 * Plan mode 的进出工具。
 *
 * 两个工具始终注册（目录稳定，进出只改提示词段），执行期再检查是否处于计划模式。
 * 计划正文走 exit 参数而不是工作区文件：评审看到的就是模型提交的那份。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { hasPlanHeading, planFilePath, planHeading } from './plan-core.js';
import type { PluginApi } from '../types.js';
import { asString, type ToolContext, type ToolResult, type ToolSpec } from '../../tools/types.js';

export function registerPlanTools(api: PluginApi): void {
  api.registerTool(enterPlanModeTool);
  api.registerTool(exitPlanModeTool);
}

export const enterPlanModeTool: ToolSpec = {
  name: 'enter_plan_mode',
  description:
    'Use enter_plan_mode when a task has ambiguity about the right approach or when the user asks you to write a plan. It switches to read-only plan mode so you can explore and design before any implementation.',
  schema: { type: 'object', properties: {} },
  async execute(_args, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.setPlanMode || !ctx.planMode) {
      return { ok: false, content: 'enter_plan_mode is only available on the root session' };
    }
    if (ctx.planMode.active) {
      return { ok: true, content: 'Already in plan mode. Explore, then present the plan with exit_plan_mode.' };
    }
    const allowed = await ctx.approve('enter_plan_mode', 'enter plan mode');
    if (!allowed) return { ok: false, content: 'enter_plan_mode was denied by the approval policy — do not retry it.' };
    ctx.setPlanMode(true);
    return {
      ok: true,
      content:
        'Plan mode is on. Explore the codebase and design the approach. Do not implement. When the plan is complete, call exit_plan_mode with the full markdown starting with a # heading.',
    };
  },
};

export const exitPlanModeTool: ToolSpec = {
  name: 'exit_plan_mode',
  description:
    'Use exit_plan_mode after you have finished writing the plan in plan mode. Send the COMPLETE markdown, starting with a # heading that names it. The user may approve (carry out the plan from your next step) or keep planning — their feedback comes back in this result; revise and present again.',
  schema: {
    type: 'object',
    properties: {
      plan: {
        type: 'string',
        description: 'The complete plan, as markdown, starting with a # heading that names it.',
      },
    },
    required: ['plan'],
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.planMode?.active) return { ok: false, content: 'exit_plan_mode is only available in plan mode' };
    const plan = asString(args, 'plan').trim();
    if (!hasPlanHeading(plan)) {
      return { ok: false, content: 'exit_plan_mode requires a non-empty markdown plan starting with a # heading' };
    }
    if (!ctx.reviewPlan || !ctx.setPlanMode) {
      return { ok: false, content: 'no review channel is available; ask the user to /plan off, or stay in plan mode' };
    }
    if (ctx.sessionDir && ctx.sessionId) {
      const path = planFilePath(ctx.sessionDir, ctx.sessionId);
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${plan}\n`, 'utf8');
      } catch {
        // 落盘失败不挡评审：计划已经在工具参数里。
      }
    }
    const review = await ctx.reviewPlan(plan, planHeading(plan) ?? 'Plan');
    if (!review.approved) {
      const feedback = review.feedback?.trim() ?? '';
      return {
        ok: false,
        content: feedback === ''
          ? 'The user chose to keep planning; revise the plan and present it again.'
          : `The user chose to keep planning; their feedback: ${feedback}`,
      };
    }
    ctx.setPlanMode(false);
    const saved = ctx.sessionDir && ctx.sessionId
      ? ` Plan saved to ${planFilePath(ctx.sessionDir, ctx.sessionId)}.`
      : '';
    return {
      ok: true,
      content: `Plan approved — plan mode exited; carry out the plan starting with your next step.${saved}`,
    };
  },
};
