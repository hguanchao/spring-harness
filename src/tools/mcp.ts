import { asString, clip, type ToolContext, type ToolResult, type ToolSpec } from './types.js';

export const mcpTool: ToolSpec = {
  name: 'mcp',
  description: 'Call a connected stdio MCP tool. action: list | call.',
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'call'] },
      server: { type: 'string' },
      tool: { type: 'string' },
      arguments: { type: 'object' },
    },
    required: ['action'],
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const action = asString(args, 'action');
    if (action === 'list') {
      return { ok: true, content: clip(JSON.stringify(ctx.mcp.listTools(), null, 2)) };
    }
    const server = asString(args, 'server');
    const tool = asString(args, 'tool');
    const raw = args.arguments;
    const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const allowed = await ctx.approve('mcp', `${server}.${tool}`);
    if (!allowed) return { ok: false, content: 'mcp call denied' };
    return { ok: true, content: clip(await ctx.mcp.call(server, tool, input)) };
  },
};
