import { asString, type ToolContext, type ToolResult, type ToolSpec } from './types.js';

export const exitPlanModeTool: ToolSpec = {
  name: 'exit_plan_mode',
  description:
    'Submit your plan for user approval to leave plan mode. Call after research, when the plan is concrete: goal, file-level steps, verification. Rejected plans come back with feedback — revise, do not start implementing.',
  schema: {
    type: 'object',
    properties: {
      plan: { type: 'string', description: 'The full plan in markdown' },
    },
    required: ['plan'],
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const plan = asString(args, 'plan');
    const outcome = await ctx.exitPlan(plan);
    if (!outcome.approved) {
      return { ok: false, content: `plan not approved. feedback: ${outcome.feedback ?? '(none)'}` };
    }
    return { ok: true, content: 'plan approved — plan mode lifted, implement it now' };
  },
};
