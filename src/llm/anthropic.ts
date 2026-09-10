import type { ChatMessage, ContentPart, ReasoningEffort } from './openai.js';
import { flattenToolSpec, type SseAcc } from './openai.js';
import type { ProtocolAdapter } from './stream-client.js';

/**
 * Anthropic Messages 协议（/v1/messages）。
 * 与 OpenAI 协议的结构差异都收敛在 toAnthropicRequest / applyAnthropicEvent：
 * system 是顶层参数、工具结果是 user 消息里的 tool_result 块、max_tokens 必填。
 */

/** Anthropic 要求 max_tokens；取各模型官方都保证的下限值，最兼容。 */
const DEFAULT_MAX_TOKENS = 8192;

/** effort → thinking 预算。off 不启用 thinking；预算必须小于 max_tokens，故同步抬高输出上限。 */
const THINKING_BUDGET: Record<Exclude<ReasoningEffort, 'off'>, number> = {
  low: 1024,
  medium: 4096,
  high: 10240,
  xhigh: 20480,
  max: 32768,
};

interface AnthropicBlock {
  type: string;
  [key: string]: unknown;
}

/** data URL 转 Anthropic base64 source；http(s) URL 走 url source。 */
function imageBlock(part: Extract<ContentPart, { type: 'image_url' }>): AnthropicBlock {
  const url = part.image_url.url;
  const match = /^data:([^;]+);base64,(.+)$/.exec(url);
  if (match) {
    return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
  }
  return { type: 'image', source: { type: 'url', url } };
}

export function toAnthropicRequest(options: {
  model: string;
  messages: ChatMessage[];
  tools: unknown[];
  reasoningEffort?: ReasoningEffort;
  maxTokens?: number;
}): Record<string, unknown> {
  const system: string[] = [];
  const messages: Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> = [];
  // Anthropic 协议里 tool_result 是 user 消息的 content 块；连续多条 tool 消息并入同一条 user。
  let pendingToolResults: AnthropicBlock[] = [];
  const flushToolResults = (): void => {
    if (pendingToolResults.length === 0) return;
    messages.push({ role: 'user', content: pendingToolResults });
    pendingToolResults = [];
  };

  for (const message of options.messages) {
    if (message.role === 'system') {
      system.push(message.content);
      continue;
    }
    if (message.role === 'tool') {
      const blocks: AnthropicBlock[] = [{ type: 'text', text: message.content }];
      if (message.parts) {
        for (const part of message.parts) {
          if (part.type === 'image_url') blocks.push(imageBlock(part));
        }
      }
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: message.tool_call_id,
        content: blocks,
      });
      continue;
    }
    flushToolResults();
    if (message.role === 'user') {
      const blocks: AnthropicBlock[] = [{ type: 'text', text: message.content }];
      if (message.parts) {
        for (const part of message.parts) {
          if (part.type === 'image_url') blocks.push(imageBlock(part));
        }
      }
      messages.push({ role: 'user', content: blocks });
      continue;
    }
    const blocks: AnthropicBlock[] = [];
    if (message.content) blocks.push({ type: 'text', text: message.content });
    for (const call of message.tool_calls ?? []) {
      let input: unknown = {};
      try {
        input = JSON.parse(call.function.arguments);
      } catch {
        input = {};
      }
      blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
    }
    messages.push({ role: 'assistant', content: blocks });
  }
  flushToolResults();

  const effort = options.reasoningEffort;
  const thinking = effort && effort !== 'off'
    ? { type: 'enabled', budget_tokens: THINKING_BUDGET[effort] }
    : undefined;
  // 输出上限：显式配置优先，未配置时用 8192；thinking 预算必须小于 max_tokens，因此仍在基数上叠加预算。
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  return {
    model: options.model,
    stream: true,
    max_tokens: thinking ? maxTokens + THINKING_BUDGET[effort as Exclude<ReasoningEffort, 'off'>] : maxTokens,
    ...(system.length > 0 ? { system: system.join('\n\n') } : {}),
    ...(thinking ? { thinking } : {}),
    ...(options.tools.length > 0
      ? {
          tools: options.tools.map((tool) => {
            const fn = flattenToolSpec(tool);
            return { name: fn.name, description: fn.description, input_schema: fn.parameters };
          }),
        }
      : {}),
    messages,
  };
}

/** Anthropic SSE 事件流 → 与 chat.completions 共享的 SseAcc 累积结构。 */
export function applyAnthropicEvent(payload: string, acc: SseAcc): { textDelta?: string } {
  const event: unknown = JSON.parse(payload);
  if (event === null || typeof event !== 'object') return {};
  const data = event as {
    type?: string;
    message?: { usage?: { input_tokens?: number } };
    index?: number;
    content_block?: { type?: string; id?: string; name?: string };
    delta?: { type?: string; text?: string; partial_json?: string; thinking?: string; stop_reason?: string; usage?: { output_tokens?: number } };
    error?: { message?: string };
  };
  if (data.error || data.type === 'error') {
    throw new Error(`Anthropic stream error: ${data.error?.message?.trim() || 'unknown'}`);
  }
  switch (data.type) {
    case 'message_start':
      acc.usage = {
        promptTokens: data.message?.usage?.input_tokens ?? 0,
        completionTokens: 0,
        totalTokens: data.message?.usage?.input_tokens ?? 0,
      };
      return {};
    case 'content_block_start':
      if (data.content_block?.type === 'tool_use') {
        acc.tools.set(data.index ?? 0, { id: data.content_block.id ?? '', name: data.content_block.name ?? '', arguments: '' });
      }
      return {};
    case 'content_block_delta':
      // thinking_delta：Anthropic 思考链增量，与 signature_delta 不同，对用户有展示价值。
      if (data.delta?.type === 'thinking_delta' && data.delta.thinking) {
        acc.thinking += data.delta.thinking;
        return {};
      }
      if (data.delta?.type === 'text_delta' && data.delta.text) {
        acc.text += data.delta.text;
        return { textDelta: data.delta.text };
      }
      if (data.delta?.type === 'input_json_delta' && data.delta.partial_json) {
        const tool = acc.tools.get(data.index ?? 0);
        if (tool) tool.arguments += data.delta.partial_json;
      }
      return {};
    case 'message_delta':
      if (data.delta?.stop_reason) {
        acc.finish = data.delta.stop_reason === 'tool_use' ? 'tool_calls' : data.delta.stop_reason === 'max_tokens' ? 'length' : 'stop';
      }
      if (acc.usage && data.delta?.usage?.output_tokens !== undefined) {
        acc.usage.completionTokens = data.delta.usage.output_tokens;
        acc.usage.totalTokens = acc.usage.promptTokens + acc.usage.completionTokens;
      }
      return {};
    default:
      // signature_delta / ping 等块对展示无意义，跳过。
      return {};
  }
}

export const anthropicAdapter: ProtocolAdapter = {
  path: '/messages',
  // x-api-key 是 Anthropic 官方鉴权头；同时带 Bearer 兼容只认 OAuth 式网关。
  headers: (apiKey) => ({
    'content-type': 'application/json',
    'x-api-key': apiKey,
    authorization: `Bearer ${apiKey}`,
    'anthropic-version': '2023-06-01',
  }),
  buildBody: (input) => JSON.stringify(toAnthropicRequest(input)),
  apply: applyAnthropicEvent,
};
