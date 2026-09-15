import { llmError } from './errors.js';
import type { ChatMessage, RequestBodyOptions } from './openai.js';
import {
  activeReasoningEffort,
  appendStreamDelta,
  flattenToolSpec,
  llmErrorMessage,
  parseSseJson,
  writeUsage,
  bearerJsonHeaders,
  type SseAcc,
} from './openai.js';
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

/**
 * 思考链的请求侧参数。
 *
 * 这里**刻意只发 `effort`，不发 `summary`**——实测（同一 prompt × 5 组 × 3 种配置，
 * 均带 tools）：
 * - 只发 effort：每一步都有 18–20 字的可见前言，reasoning 事件 0 个；
 * - 加 `summary: 'auto'` 或 `'detailed'`：可见文本变成 **0 字（5/5）**，reasoning 事件
 *   仍然是 **0 个**。
 *
 * 也就是说，在**工具调用轮次**里该端点根本不推 reasoning 事件；而一旦申请摘要，
 * 模型会把本来写在可见输出里的那句「我先看什么」挪进推理通道，于是用户两头都拿不到。
 * 这是净回归，故不发。
 *
 * 纯生成轮次（无工具）下 `summary: 'auto'` 是有效的（实测 6/6 拿到摘要），
 * 消费侧对 `response.reasoning_summary_text.delta` 的解析已按规范实现（字段是 `delta`），
 * 所以哪天换个会推摘要的端点，打开这里就能用。
 */
const REQUEST_REASONING_SUMMARY = false;

export function buildResponsesRequest(options: RequestBodyOptions): Record<string, unknown> {
  const effort = activeReasoningEffort(options.reasoningEffort);
  return {
    model: options.model,
    stream: true,
    input: toResponsesInput(options.messages),
    // Responses 的工具定义是扁平结构，openaiTools() 产出的是嵌套 function 形态，这里摊平。
    ...(options.tools.length > 0
      ? { tools: options.tools.map((tool) => ({ type: 'function', ...flattenToolSpec(tool) })) }
      : {}),
    ...(effort
      ? { reasoning: REQUEST_REASONING_SUMMARY ? { effort, summary: 'auto' } : { effort } }
      : {}),
    // 仅在显式配置时发送，未配置时输出上限由端点决定。
    ...(options.maxTokens !== undefined ? { max_output_tokens: options.maxTokens } : {}),
  };
}

/** Responses SSE 事件流 → 与 chat.completions 共享的 SseAcc 累积结构。 */
export function applyResponsesEvent(payload: string, acc: SseAcc): { textDelta?: string; thinkingDelta?: string } {
  const event = parseSseJson(payload);
  if (!event) return {};
  const data = event as {
    type?: string;
    delta?: string;
    summary?: string;
    summary_index?: number;
    part?: { type?: string; text?: string };
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
      return data.delta ? appendStreamDelta(acc, data.delta) : {};
    // 推理模型的思考链。三类事件的增量文本都在 `delta` 字段里——`summary` 是
    // `reasoning_summary_text.done` 才有的整段文本，不能拿来当增量读。
    case 'response.reasoning_text.delta':
    case 'response.reasoning_summary_text.delta':
      return data.delta ? appendStreamDelta(acc, undefined, data.delta) : {};
    // 一次推理可能分多段摘要；不补分隔符两段会挤成一行。
    case 'response.reasoning_summary_part.added':
      return data.summary_index !== undefined && data.summary_index > 0
        ? appendStreamDelta(acc, undefined, '\n\n')
        : {};
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
        writeUsage(
          acc,
          usage.input_tokens ?? 0,
          usage.output_tokens ?? 0,
          usage.total_tokens,
          typeof cached === 'number' && Number.isFinite(cached) ? cached : undefined,
        );
      }
      acc.finish = data.type === 'response.incomplete' ? 'length' : 'stop';
      return {};
    }
    case 'response.failed':
      throw llmError('Responses stream failed', llmErrorMessage(data.response?.error));
    case 'error':
      throw llmError('Responses stream error', llmErrorMessage((data as { error?: unknown }).error));
    default:
      // 部分端点把 error 塞在非 failed 事件里。
      if ((data as { error?: unknown }).error) {
        throw llmError('Responses stream error', llmErrorMessage((data as { error?: unknown }).error));
      }
      return {};
  }
}

export const responsesAdapter: ProtocolAdapter = {
  path: '/responses',
  headers: bearerJsonHeaders,
  buildBody: (input) => JSON.stringify(buildResponsesRequest(input)),
  apply: applyResponsesEvent,
};
