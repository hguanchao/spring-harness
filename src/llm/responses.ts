import { DEFAULT_REQUEST_CAPS, degradeRequestCaps, type RequestCaps } from './compat.js';
import { llmError } from './errors.js';
import { clampPromptCacheKey, PROMPT_CACHE_RETENTION } from './prompt-cache.js';
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

export function toResponsesInput(
  messages: ChatMessage[],
  caps: RequestCaps = DEFAULT_REQUEST_CAPS,
): InputItem[] {
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
    // 推理项必须排在它引用的输出项之前：服务端按序重建那一轮的推理状态。
    //
    // 默认回传，因为**无状态调用下这是唯一保住跨步推理状态的手段**（本项目每次把完整
    // input 重发，不用 previous_response_id）。但部分转手中转站会以
    // `encrypted_content was not issued to this caller` 拒绝——那是端点属性，不该拿来
    // 全局牺牲质量，所以改为「先发，被拒后按报文降级」（见 compat.ts）。
    if (caps.sendReasoning) {
      for (const item of message.reasoning ?? []) {
        if (!item.encryptedContent) continue;
        items.push({
          type: 'reasoning',
          id: item.id,
          encrypted_content: item.encryptedContent,
          // `summary` 是**必需字段**而不是可选字段：整个键缺席时上游直接 400
          // `input[N] missing required field 'summary'`（N 指向本项）。而这里从不申请
          // reasoning 摘要（见下方 REQUEST_REASONING_SUMMARY），摘要基本永远是空的——
          // 空数组是合法值，键本身必须在。曾经写成「有摘要才带上」，结果只要回传
          // reasoning 就必然被拒，多步工具轮次直接跑不下去。
          summary: item.summary ? [{ type: 'summary_text', text: item.summary }] : [],
        });
      }
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

export function buildResponsesRequest(
  options: RequestBodyOptions,
  caps: RequestCaps = DEFAULT_REQUEST_CAPS,
): Record<string, unknown> {
  const effort = activeReasoningEffort(options.reasoningEffort);
  return {
    model: options.model,
    stream: true,
    input: toResponsesInput(options.messages, caps),
    // Responses 的工具定义是扁平结构，而 ToolRegistry.schemas() 产出的是嵌套 function 形态，这里摊平。
    ...(options.tools.length > 0
      ? {
          tools: options.tools.map((tool) => ({ type: 'function', ...flattenToolSpec(tool) })),
          // zen/cliproxy：缺 tool_choice 会把 function_call 剥掉，只剩「继续看…」前言然后停轮。
          tool_choice: 'auto',
        }
      : {}),
    ...(effort
      ? { reasoning: REQUEST_REASONING_SUMMARY ? { effort, summary: 'auto' } : { effort } }
      : {}),
    // 仅在显式配置时发送，未配置时输出上限由端点决定。
    ...(options.maxTokens !== undefined ? { max_output_tokens: options.maxTokens } : {}),
    // 缓存路由与保留时间和 chat.completions 同名同义；被端点拒绝时同样由 degrade 摘掉。
    ...(caps.promptCacheKey && options.sessionId !== undefined
      ? { prompt_cache_key: clampPromptCacheKey(options.sessionId) }
      : {}),
    ...(caps.promptCacheRetention ? { prompt_cache_retention: PROMPT_CACHE_RETENTION } : {}),
    // 显式关掉服务端留存：本项目每次把完整 input 重发（不用 previous_response_id），
    // 留存对功能毫无帮助，却与「跑在用户自己机器上」的定位相悖。端点不认这个参数时由
    // degrade 摘掉——那是拿隐私换兼容，但好过硬失败。
    ...(caps.sendStore ? { store: false } : {}),
  };
}

function toolForDelta(acc: SseAcc, itemId?: string): { id: string; name: string; arguments: string; itemId?: string } | undefined {
  if (itemId) {
    for (const tool of acc.tools.values()) {
      if (tool.itemId === itemId) return tool;
    }
  }
  return acc.currentToolIndex !== undefined ? acc.tools.get(acc.currentToolIndex) : undefined;
}

function upsertReasoning(
  acc: SseAcc,
  item: { id?: string; encrypted_content?: string | null; summary?: Array<{ type?: string; text?: string }> },
): void {
  const id = item.id;
  if (!id) return;
  const current = acc.reasoningItems.get(id) ?? { id };
  if (typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0) {
    current.encryptedContent = item.encrypted_content;
  }
  if (item.summary && item.summary.length > 0) {
    const text = item.summary.map((part) => part.text ?? '').filter(Boolean).join('\n\n');
    if (text) current.summary = text;
  }
  acc.reasoningItems.set(id, current);
}

function upsertFunctionCall(
  acc: SseAcc,
  item: { id?: string; call_id?: string; name?: string; arguments?: string },
): void {
  const callId = item.call_id ?? '';
  for (const tool of acc.tools.values()) {
    if ((callId && tool.id === callId) || (item.id && tool.itemId === item.id)) {
      if (item.name) tool.name = item.name;
      if (item.arguments !== undefined) tool.arguments = item.arguments;
      return;
    }
  }
  const index = acc.tools.size;
  acc.tools.set(index, {
    id: callId,
    name: item.name ?? '',
    arguments: item.arguments ?? '',
    itemId: item.id,
  });
  acc.currentToolIndex = index;
}

/** Responses SSE 事件流 → 与 chat.completions 共享的 SseAcc 累积结构。 */
export function applyResponsesEvent(payload: string, acc: SseAcc): { textDelta?: string; thinkingDelta?: string } {
  if (payload === '[DONE]') return {};
  const event = parseSseJson(payload);
  if (!event) return {};
  const data = event as {
    type?: string;
    delta?: string;
    item_id?: string;
    summary?: string;
    summary_index?: number;
    part?: { type?: string; text?: string };
    item?: {
      type?: string;
      id?: string;
      call_id?: string;
      name?: string;
      arguments?: string;
      encrypted_content?: string | null;
      summary?: Array<{ type?: string; text?: string }>;
    };
    response?: {
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
        input_tokens_details?: { cached_tokens?: number };
      };
      error?: { message?: string } | null;
      status?: string;
      output?: Array<{
        type?: string;
        id?: string;
        call_id?: string;
        name?: string;
        arguments?: string;
        encrypted_content?: string | null;
        summary?: Array<{ type?: string; text?: string }>;
        content?: Array<{ type?: string; text?: string }>;
      }>;
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
      if (data.item?.type === 'reasoning') upsertReasoning(acc, data.item);
      if (data.item?.type === 'function_call') {
        const index = acc.tools.size;
        acc.tools.set(index, {
          id: data.item.call_id ?? '',
          name: data.item.name ?? '',
          arguments: data.item.arguments ?? '',
          itemId: data.item.id,
        });
        acc.currentToolIndex = index;
      }
      return {};
    case 'response.function_call_arguments.delta':
      if (data.delta) {
        const tool = toolForDelta(acc, data.item_id);
        if (tool) tool.arguments += data.delta;
      }
      return {};
    case 'response.output_item.done':
      if (data.item?.type === 'reasoning') upsertReasoning(acc, data.item);
      if (data.item?.type === 'function_call') {
        upsertFunctionCall(acc, data.item);
      }
      return {};
    case 'response.completed':
    case 'response.incomplete': {
      let textDelta: string | undefined;
      for (const item of data.response?.output ?? []) {
        if (item?.type === 'reasoning') upsertReasoning(acc, item);
        if (item?.type === 'function_call') upsertFunctionCall(acc, item);
        // 流式路径里正文已经由 output_text.delta 写过；非流式完整报文只在这里有正文。
        if (!acc.text && item?.type === 'message') {
          for (const part of item.content ?? []) {
            if ((part.type === 'output_text' || part.type === 'text') && part.text) {
              textDelta = (textDelta ?? '') + (appendStreamDelta(acc, part.text).textDelta ?? '');
            }
          }
        }
      }
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
      return { textDelta };
    }
    case 'response.failed':
      throw llmError('Responses stream failed', llmErrorMessage(data.response?.error));
    case 'error':
      throw llmError('Responses stream error', llmErrorMessage((data as { error?: unknown }).error));
    default: {
      // 非流式完整报文：`{ object: "response", status, output }`，没有 `type: response.completed`。
      const status = (data as { status?: string }).status;
      const output = (data as { output?: unknown }).output;
      if ((status === 'completed' || status === 'incomplete') && Array.isArray(output)) {
        return applyResponsesEvent(
          JSON.stringify({
            type: status === 'incomplete' ? 'response.incomplete' : 'response.completed',
            response: data,
          }),
          acc,
        );
      }
      // 部分端点把 error 塞在非 failed 事件里。
      if ((data as { error?: unknown }).error) {
        throw llmError('Responses stream error', llmErrorMessage((data as { error?: unknown }).error));
      }
      return {};
    }
  }
}

export const responsesAdapter: ProtocolAdapter = {
  path: '/responses',
  headers: bearerJsonHeaders,
  buildBody: (input, caps) => JSON.stringify(buildResponsesRequest(input, caps)),
  apply: applyResponsesEvent,
  degrade: degradeRequestCaps,
};
