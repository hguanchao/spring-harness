import { asString, type ToolContext, type ToolResult, type ToolSpec } from './types.js';

export const askUserTool: ToolSpec = {
  name: 'ask_user',
  description: 'Ask the human one question and wait for the answer. Reserve it for ambiguity that changes the approach — not for confirming an obvious next step, cadence checks, or asking where code lives when you can look. Headless sessions return denied unless a listener answers, so prefer proceeding when the answer is inferable.',
  schema: {
    type: 'object',
    properties: { question: { type: 'string' } },
    required: ['question'],
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const question = asString(args, 'question');
    const answer = await ctx.askUser(question);
    if (!answer) return { ok: false, content: 'ask_user denied or unanswered' };
    return { ok: true, content: answer };
  },
};
