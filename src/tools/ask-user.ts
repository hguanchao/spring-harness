import { asString, type ToolContext, type ToolResult, type ToolSpec } from './types.js';

export const askUserTool: ToolSpec = {
  name: 'ask_user',
  description: 'Ask the human one question and wait. Headless returns denied unless a listener answers.',
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
