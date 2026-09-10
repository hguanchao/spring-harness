import type { ChatMessage, ReasoningEffort } from './openai.js';
import { llmErrorMessage, flattenToolSpec, type SseAcc } from './openai.js';
import type { ProtocolAdapter } from './stream-client.js';

/**
 * OpenAI Responses 协议（/v1/responses）。
 * 与 chat.completions 的差异收敛在 toResponsesInput / applyResponsesEvent：
 * 工具定义是扁平结构、历史以 input items 表达、reasoning 力度走 reasoning.effort。
 */

type InputItem = Record<string, unknown>;

export function toResponsesInput(messages: ChatMessage[]): InputItem[] {
  const items: InputItem[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      items.push({ role: 'system', content: [{ type: 'input_text', text: message.content }] });
      continue;
    }
    if (message.role === 'tool') {
      items.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content });
      continue;
    }
    if (message.role === 'user') {
      const content: Array<Record<string, unknown>> = [{ type: 'input_text', text: message.content }];
      for (const part of message.parts ?? []) {
        if (part.type === 'image_url') content.push({ type: 'input_image', image_url: part.image_url.url });
      }
      items.push({ role: 'user', content });
      continue;
    }
    if (message.content) {
      items.push({ role: 'assistant', content: [{ type: 'output_text', text: message.content }] });
    }
    for (const call of message.tool_calls ?? []) {
      items.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    }
  }
  return items;
}

export function buildResponsesRequest(options: {
  model: string;
  messages: ChatMessage[];
  tools: unknown[];
  reasoningEffort?: ReasoningEffort;
  maxTokens?: number;
}): Record<string, unknown> {
  return {
    model: options.model,
    stream: true,
    input: toResponsesInput(options.messages),
    // Responses 的工具定义是扁平结构，openaiTools() 产出的是嵌套 function 形态，这里摊平。
    ...(options.tools.length > 0
      ? { tools: options.tools.map((tool) => ({ type: 'function', ...flattenToolSpec(tool) })) }
      : {}),
    ...(options.reasoningEffort && options.reasoningEffort !== 'off'
      ? { reasoning: { effort: options.reasoningEffort } }
      : {}),
    // 仅在显式配置时发送，未配置时输出上限由端点决定。
    ...(options.maxTokens !== undefined ? { max_output_tokens: options.maxTokens } : {}),
  };
}

/** Responses SSE 事件流 → 与 chat.completions 共享的 SseAcc 累积结构。 */
export function applyResponsesEvent(payload: string, acc: SseAcc): { textDelta?: string } {
  const event: unknown = JSON.parse(payload);
  if (event === null || typeof event !== 'object') return {};
  const data = event as {
    type?: string;
    delta?: string;
    summary?: string;
    item?: { type?: string; call_id?: string; name?: string; arguments?: string };
    response?: {
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
        input_tokens_details?: { cached_tokens?: number };
      };
      error?: { message?: string } | null;
      status?: string;
    };
  };
  switch (data.type) {
    case 'response.output_text.delta':
      if (data.delta) {
        acc.text += data.delta;
        return { textDelta: data.delta };
      }
      return {};
    // 推理模型的思考链：reasoning_text.delta 是完整思考增量；summary 事件（摘要）在其自己的 summary 字段里。
    case 'response.reasoning_text.delta':
      if (data.delta) acc.thinking += data.delta;
      return {};
    case 'response.reasoning_summary_text.delta':
      if (data.summary) acc.thinking += data.summary;
      return {};
    case 'response.output_item.added':
      if (data.item?.type === 'function_call') {
        const index = acc.tools.size;
        acc.tools.set(index, { id: data.item.call_id ?? '', name: data.item.name ?? '', arguments: data.item.arguments ?? '' });
        acc.currentToolIndex = index;
      }
      return {};
    case 'response.function_call_arguments.delta':
      if (data.delta) {
        const tool = acc.currentToolIndex !== undefined ? acc.tools.get(acc.currentToolIndex) : undefined;
        if (tool) tool.arguments += data.delta;
      }
      return {};
    case 'response.completed':
    case 'response.incomplete': {
      const usage = data.response?.usage;
      if (usage) {
        const cached = usage.input_tokens_details?.cached_tokens;
        acc.usage = {
          promptTokens: usage.input_tokens ?? 0,
          completionTokens: usage.output_tokens ?? 0,
          totalTokens: usage.total_tokens ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
          ...(typeof cached === 'number' && Number.isFinite(cached) ? { cachedTokens: cached } : {}),
        };
      }
      acc.finish = data.type === 'response.incomplete' ? 'length' : 'stop';
      return {};
    }
    case 'response.failed':
      throw new Error(`Responses stream failed: ${llmErrorMessage(data.response?.error)}`);
    case 'error':
      throw new Error(`Responses stream error: ${llmErrorMessage((data as { error?: unknown }).error)}`);
    default:
      // 部分端点把 error 塞在非 failed 事件里。
      if ((data as { error?: unknown }).error) {
        throw new Error(`Responses stream error: ${llmErrorMessage((data as { error?: unknown }).error)}`);
      }
      return {};
  }
}

export const responsesAdapter: ProtocolAdapter = {
  path: '/responses',
  headers: (apiKey) => ({ 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }),
  buildBody: (input) => JSON.stringify(buildResponsesRequest(input)),
  apply: applyResponsesEvent,
};
