import { asString, clip, type ToolContext, type ToolResult, type ToolSpec } from './types.js';

export const sendSubagentMessageTool: ToolSpec = {
  name: 'send_subagent_message',
  description:
    "Send a message to a RUNNING background subagent you own, addressed by its subagent session id. The message is delivered at the subagent's next safe point (steer). Root session only — subagents cannot message each other. If the target already completed, the call fails: spawn a new subagent with resume_from instead.",
  schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Target subagent session id (from the subagent result footer or jobs output)' },
      message: { type: 'string', description: 'Message text delivered to the subagent as a user message' },
    },
    required: ['id', 'message'],
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const id = asString(args, 'id');
    const message = asString(args, 'message');
    const outcome = ctx.sendToSubagent(id, clip(message));
    if (outcome === 'queued') return { ok: true, content: `message queued for delivery to subagent ${id}` };
    if (outcome === 'completed') {
      return {
        ok: false,
        content: `subagent ${id} already completed — spawn a new subagent with resume_from: "${id}" instead`,
      };
    }
    return { ok: false, content: `subagent ${id} not found or not addressable (only running background subagents can receive messages)` };
  },
};
