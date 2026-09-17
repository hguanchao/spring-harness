import { firstString, TEXT_KEYS, THINKING_KEYS } from './aliases.js';
import { DEFAULT_REQUEST_CAPS, degradeRequestCaps, type RequestCaps } from './compat.js';
import { llmError } from './errors.js';
import type { ChatMessage, ContentPart, ReasoningEffort, RequestBodyOptions } from './openai.js';
import { appendStreamDelta, flattenToolSpec, parseSseJson, writeUsage, type SseAcc } from './openai.js';
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

/**
 * prompt-cache 断点。Anthropic 允许最多 4 个，这里用 3 个覆盖三段前缀
 * （工具定义 → 系统提示词 → 已有对话），把 agent 每步重发的大头都变成缓存命中。
 *
 * 不加 `anthropic-beta` 头：prompt caching 已 GA，beta 头反而会被部分网关拒绝。
 */
const CACHE_BREAKPOINT = { type: 'ephemeral' } as const;

/** data URL 转 Anthropic base64 source；http(s) URL 走 url source。 */
function imageBlock(part: Extract<ContentPart, { type: 'image_url' }>): AnthropicBlock {
  const url = part.image_url.url;
  const match = /^data:([^;]+);base64,(.+)$/.exec(url);
  if (match) {
    return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
  }
  return { type: 'image', source: { type: 'url', url } };
}

/**
 * 正文文本 + 图片 part → Anthropic content blocks（tool / user 两条路径共用）。
 *
 * 空正文不推 text 块：Anthropic 拒收空 text（"text content blocks must be non-empty"），
 * 而空结果在工具侧是真会出现的（例如 headless 下 ask_user 无输入通道）。
 */
function textAndImageBlocks(message: ChatMessage): AnthropicBlock[] {
  const blocks: AnthropicBlock[] = [];
  if (message.content) blocks.push({ type: 'text', text: message.content });
  for (const part of message.parts ?? []) {
    if (part.type === 'image_url') blocks.push(imageBlock(part));
  }
  return blocks;
}

/** tool_result 的 content 不能为空数组，兜一个占位块，免得整段历史被判 400。 */
function toolResultContent(message: ChatMessage): AnthropicBlock[] {
  const blocks = textAndImageBlocks(message);
  return blocks.length > 0 ? blocks : [{ type: 'text', text: '(no output)' }];
}

/**
 * 断点在消息侧的落点：**上一次请求的结束位置**，即最后一条 assistant 消息。
 *
 * 为什么不落在绝对末尾：agent 每步把 assistant 回复与 tool result 追加到末尾，断点跟着
 * 滑动。锚在最后一条 assistant 消息上，锚点每步只前进一个来回（两条消息），永远在
 * cache lookback 窗口够得着的范围内；而当前步的 tool result 留在断点之后，本步按原价
 * 读取、下一步起进入缓存前缀——写入点只比旧行为晚一步，却少占一个断点槽位
 * （4 个槽只用 3 个，留 1 个给网关注入自己的断点）。
 *
 * thinking / redacted_thinking 块不承载 cache_control（API 直接拒绝挂点），选块时跳过。
 */
const CACHEABLE_BLOCK_TYPES = new Set(['text', 'image', 'document', 'tool_use', 'tool_result']);

function lastCacheableBlock(content: readonly AnthropicBlock[]): AnthropicBlock | undefined {
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i]!;
    if (block.type === 'thinking' || block.type === 'redacted_thinking') continue;
    if (CACHEABLE_BLOCK_TYPES.has(block.type)) return block;
  }
  return undefined;
}

function markMessagesForCaching(
  messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }>,
): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role !== 'assistant') continue;
    const block = lastCacheableBlock(messages[i]!.content);
    if (block) {
      block.cache_control = CACHE_BREAKPOINT;
      return;
    }
    // 最后一条 assistant 整个是 thinking（无正文无工具调用）时不再往前找：
    // 断点丢进更早的历史会让最近几个来回永远出不了缓存，宁可退回末尾消息。
    break;
  }
  // 新会话的第一步还没有任何 assistant 消息：退回最后一条消息。
  const block = lastCacheableBlock(messages.at(-1)?.content ?? []);
  if (block) block.cache_control = CACHE_BREAKPOINT;
}

export function toAnthropicRequest(
  options: RequestBodyOptions,
  caps: RequestCaps = DEFAULT_REQUEST_CAPS,
): Record<string, unknown> {
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
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: message.tool_call_id,
        content: toolResultContent(message),
      });
      continue;
    }
    flushToolResults();
    if (message.role === 'user') {
      const blocks = textAndImageBlocks(message);
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
    // 空 content 数组会被 Anthropic 拒：只在真的有块时推这条 assistant 消息。
    // 只有「既无正文也无工具调用」的空轮会落进这里——它对历史没有任何信息量。
    if (blocks.length > 0) messages.push({ role: 'assistant', content: blocks });
  }
  flushToolResults();

  const effort = options.reasoningEffort;
  const thinking = effort && effort !== 'off'
    ? { type: 'enabled', budget_tokens: THINKING_BUDGET[effort] }
    : undefined;
  // 输出上限：显式配置优先，未配置时用 8192；thinking 预算必须小于 max_tokens，因此仍在基数上叠加预算。
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

  const tools: Array<Record<string, unknown>> = options.tools.map((tool) => {
    const fn = flattenToolSpec(tool);
    return { name: fn.name, description: fn.description, input_schema: fn.parameters };
  });
  if (caps.promptCache && tools.length > 0) {
    // 断点打在最后一个工具上：Anthropic 缓存「到断点为止」的整段前缀，一个就够覆盖整批工具定义。
    tools[tools.length - 1].cache_control = CACHE_BREAKPOINT;
  }
  if (caps.promptCache) markMessagesForCaching(messages);

  const systemText = system.join('\n\n');
  return {
    model: options.model,
    stream: true,
    max_tokens: thinking ? maxTokens + THINKING_BUDGET[effort as Exclude<ReasoningEffort, 'off'>] : maxTokens,
    // 缓存断点要求 system 是块数组而不是裸字符串。
    ...(systemText === ''
      ? {}
      : {
          system: caps.promptCache
            ? [{ type: 'text', text: systemText, cache_control: CACHE_BREAKPOINT }]
            : systemText,
        }),
    ...(thinking ? { thinking } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    messages,
  };
}

function mapAnthropicStop(reason: string): string {
  return reason === 'tool_use' ? 'tool_calls' : reason === 'max_tokens' ? 'length' : 'stop';
}

/** Anthropic SSE 事件流 → 与 chat.completions 共享的 SseAcc 累积结构。 */
export function applyAnthropicEvent(payload: string, acc: SseAcc): { textDelta?: string; thinkingDelta?: string } {
  if (payload === '[DONE]') return {};
  const event = parseSseJson(payload);
  if (!event) return {};
  const data = event as {
    type?: string;
    message?: {
      usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    };
    index?: number;
    content_block?: { type?: string; id?: string; name?: string };
    delta?: { type?: string; text?: string; partial_json?: string; thinking?: string; stop_reason?: string; usage?: { output_tokens?: number } };
    error?: { message?: string };
    content?: Array<{ type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown }>;
    stop_reason?: string;
  };
  if (data.error || data.type === 'error') {
    throw llmError('Anthropic stream error', data.error?.message?.trim() || 'unknown');
  }
  switch (data.type) {
    case 'message': {
      // 非流式完整报文（网关把 stream 折成一条 JSON）。
      let textDelta: string | undefined;
      let thinkingDelta: string | undefined;
      for (const [index, block] of (data.content ?? []).entries()) {
        if (block.type === 'text' && block.text) {
          textDelta = (textDelta ?? '') + (appendStreamDelta(acc, block.text).textDelta ?? '');
        } else if (block.type === 'thinking' && (block.thinking || block.text)) {
          thinkingDelta = (thinkingDelta ?? '') + (appendStreamDelta(acc, undefined, block.thinking || block.text).thinkingDelta ?? '');
        } else if (block.type === 'tool_use') {
          acc.tools.set(index, {
            id: block.id ?? '',
            name: block.name ?? '',
            arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}),
          });
        }
      }
      if (data.stop_reason) acc.finish = mapAnthropicStop(data.stop_reason);
      return { textDelta, thinkingDelta };
    }
    case 'message_start': {
      // Anthropic 的 input_tokens 不含缓存部分，这里归一化成「含缓存的总输入」，
      // 与 chat-completions / responses 的口径一致（命中率与窗口占用都需要总输入量）。
      const uncached = data.message?.usage?.input_tokens ?? 0;
      const cacheRead = data.message?.usage?.cache_read_input_tokens ?? 0;
      const cacheWrite = data.message?.usage?.cache_creation_input_tokens ?? 0;
      const prompt = uncached + cacheRead + cacheWrite;
      writeUsage(acc, prompt, 0, prompt, cacheRead + cacheWrite === 0 ? undefined : cacheRead);
      return {};
    }
    case 'content_block_start':
      if (data.content_block?.type === 'tool_use') {
        acc.tools.set(data.index ?? 0, { id: data.content_block.id ?? '', name: data.content_block.name ?? '', arguments: '' });
      }
      return {};
    case 'content_block_delta':
      // thinking_delta：Anthropic 思考链增量，与 signature_delta 不同，对用户有展示价值。
      if (data.delta?.type === 'thinking_delta') {
        const thinking = firstString(data.delta as unknown as Record<string, unknown>, THINKING_KEYS)
          ?? (typeof data.delta.text === 'string' && data.delta.text ? data.delta.text : undefined);
        if (thinking) return appendStreamDelta(acc, undefined, thinking);
      }
      if (data.delta?.type === 'text_delta') {
        const text = firstString(data.delta as unknown as Record<string, unknown>, TEXT_KEYS);
        if (text) return appendStreamDelta(acc, text);
      }
      if (data.delta?.type === 'input_json_delta' && data.delta.partial_json) {
        const tool = acc.tools.get(data.index ?? 0);
        if (tool) tool.arguments += data.delta.partial_json;
      }
      return {};
    case 'message_delta':
      if (data.delta?.stop_reason) {
        acc.finish = mapAnthropicStop(data.delta.stop_reason);
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
  buildBody: (input, caps) => JSON.stringify(toAnthropicRequest(input, caps)),
  apply: applyAnthropicEvent,
  degrade: degradeRequestCaps,
};
