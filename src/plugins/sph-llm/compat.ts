import { type CompatProfile } from '../../config/primitives.js';

/**
 * 请求参数容忍度（caps）：把「同一协议在不同端点上的参数差异」收敛成一组布尔位。
 *
 * 为什么单独成模块：`chat-completions` / `responses` 是两套协议，但**同一个协议在不同
 * 端点上的可接受参数并不相同**。三种已确认的真实差异：
 * - 输出上限有三个名字：`max_tokens`、`max_completion_tokens`、`max_output_tokens`。
 *   官方 OpenAI 用第二个，Responses 用第三个，其余兼容端点用第一个；报文点名再换。
 * - `stream_options` 是 OpenAI 私有扩展，部分兼容端点遇到未知字段直接 400；
 * - Responses 的 reasoning 项在转手中转站会被拒（`encrypted_content was not issued
 *   to this caller`），而官方端点需要它来跨步保留推理状态。
 *
 * 处理分三层，后一层覆盖前一层：
 * 1. 默认当兼容网关：未知 `base_url` 不发 `prompt_cache_key` / `prompt_cache_retention`。
 *    只对官方 OpenAI API 主机开缓存路由键。不维护厂商名单。
 * 2. `[compat]` 声明：用户点名的位覆盖推断。`prompt_cache = false` 一票否决缓存相关位。
 * 3. 从端点报文反推（degradeRequestCaps）：声明错了或启发式猜不到时，按 400 剥字段。
 *    这是兜底，不是主路径。
 *
 * 记忆范围是「一个 client 对象」（≈ 一个进程 / 会话）：降级后同一会话内不再重复踩。
 * 刻意不落盘：参数容忍度是**端点**属性，换端点或网关升级都会变，缓存一份可能过期的
 * 能力表比每次实测更危险。
 */

/**
 * chat.completions 输出上限的字段名。
 * Responses 协议固定用 `max_output_tokens`，不读这一位。
 */
export const OUTPUT_LIMIT_FIELDS = ['max_tokens', 'max_completion_tokens', 'max_output_tokens'] as const;
export type OutputLimitField = (typeof OUTPUT_LIMIT_FIELDS)[number];

/**
 * 推理档位在 chat.completions 上的写法。报文点名另一个字段才换，不按模型名猜。
 * `off` 表示这个端点不收任何推理开关。
 */
export const REASONING_WIRES = ['effort', 'object', 'thinking', 'enable_thinking', 'off'] as const;
export type ReasoningWire = (typeof REASONING_WIRES)[number];

/** 一次请求的参数形态。adapter 只读它来决定发什么字段，不感知它是猜的还是学来的。 */
export interface RequestCaps {
  /** chat.completions 把输出上限写进哪个字段。 */
  outputLimit: OutputLimitField;
  /**
   * 推理档位怎么写。`effort` 是 `reasoning_effort`，`object` 是 `reasoning.effort`，
   * `thinking` 是 `{ type: "enabled" }`，`enable_thinking` 是布尔。
   */
  reasoningWire: ReasoningWire;
  /**
   * Anthropic thinking 用 `type: "adaptive"`，而不是 `enabled` + `budget_tokens`。
   * 新模型拒预算、旧模型拒 adaptive，两边都由报文翻转，不看模型名。
   */
  adaptiveThinking: boolean;
  /** chat.completions 发送 `stream_options: { include_usage: true }`。 */
  streamOptions: boolean;
  /** Responses 发送 `store: false`（对话不留在服务端）。 */
  sendStore: boolean;
  /** Responses 回传 reasoning items（跨步保留推理状态）。 */
  sendReasoning: boolean;
  /** Anthropic 打 prompt-cache 断点。 */
  promptCache: boolean;
  /**
   * 发送 `prompt_cache_key`（会话级的缓存路由键）。
   *
   * 不是「让缓存生效」的开关——OpenAI 系的前缀缓存本来就是自动的——而是让同一个
   * 会话的请求**落到同一台机器**上。分散路由会各自维护一份前缀缓存，命中率随之摊薄。
   */
  promptCacheKey: boolean;
  /**
   * 发送 `prompt_cache_retention: "24h"`。
   *
   * 明确要求延长缓存保留时间，只有部分模型接受。读缓存本身不额外收费，
   * 所以这是纯上行的收益；端点不认时报文会把它降下来。
   */
  promptCacheRetention: boolean;
}

export {
  SESSION_AFFINITY_FORMATS,
  type CompatProfile,
  type SessionAffinityFormat,
} from '../../config/primitives.js';

/** 七个能力位均为「现代端点默认形态」；各 adapter 的默认参数值。 */
export const DEFAULT_REQUEST_CAPS: RequestCaps = Object.freeze({
  outputLimit: 'max_tokens',
  reasoningWire: 'effort',
  adaptiveThinking: false,
  streamOptions: true,
  sendStore: true,
  sendReasoning: true,
  promptCache: true,
  promptCacheKey: true,
  promptCacheRetention: true,
});

export interface InitialCapsOptions {
  baseUrl?: string;
  compat?: CompatProfile;
}

/**
 * 首个请求的初始能力位。
 *
 * `promptCache` 来自配置，一票否决 Anthropic 断点与 OpenAI 系 cache 字段。
 * 输出上限先发该协议的文档默认名（chat 是 `max_tokens`）。端点报文点了别的名字再换。
 * `prompt_cache_key` 在打开 prompt cache 时发出，被拒就摘掉。`prompt_cache_retention`
 * 只有 compat 显式打开才发。不看主机名。
 */
export function initialRequestCaps(
  _model: string,
  promptCache: boolean,
  options: InitialCapsOptions = {},
): RequestCaps {
  const override = options.compat;
  return {
    outputLimit: 'max_tokens',
    reasoningWire: 'effort',
    adaptiveThinking: false,
    streamOptions: override?.streamOptions ?? true,
    sendStore: true,
    sendReasoning: true,
    promptCache,
    promptCacheKey: promptCache && (override?.promptCacheKey ?? true),
    promptCacheRetention: promptCache && (override?.promptCacheRetention ?? false),
  };
}

/** 端点说「不认识这个参数」时的措辞。刻意放宽——宁可多降一级，也不要硬失败。 */
const UNSUPPORTED_WORDS = [
  'unsupported',
  'not supported',
  'does not support',
  'unknown parameter',
  'unrecognized',
  'unrecognised',
  'invalid parameter',
  'unexpected',
  'not allowed',
  'not permitted',
  'extra inputs',
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 报文里是否点名了某个参数。用词边界而不是裸 includes：
 * `\bstore\b` 不会命中 `restore`，`\bmax_tokens\b` 也不会命中 `max_completion_tokens`
 * （后者根本不是前者的子串，两个方向都得防）。
 */
function mentionsParam(text: string, name: string): boolean {
  return new RegExp(`['"\`]${escapeRegExp(name)}['"\`]|\\b${escapeRegExp(name)}\\b`).test(text);
}

/**
 * 从端点错误报文反推新的能力位。返回 undefined 表示「这不是参数容忍度问题」，
 * 调用方应原样抛出该错误。
 *
 * 顺序上先处理「报文已明确指出该换成哪个名字」的两条，它们不必再要求出现
 * unsupported 字样（zen Console 拒绝 reasoning 时的措辞里就没有）。
 *
 * 两个名字同时出现时（OpenAI 的真实报文就是如此：`Unsupported parameter:
 * 'max_tokens' ... Use 'max_completion_tokens' instead.`）优先按「迁向新名字」处理——
 * 现实中 `max_tokens` 是正在被取代的旧名，反方向极少发生。即便猜错也不会死循环：
 * 下一轮报文会命中反向规则翻回来，整体由调用方的次数上限收口。
 */
/** 报文点了另一个上限字段就换过去。两个名字同时出现时优先 `max_completion_tokens`。 */
function nextOutputLimit(current: OutputLimitField, text: string): OutputLimitField | undefined {
  const hinted = /use\s+['"`]?([a-z0-9_]+)['"`]?/.exec(text)?.[1];
  if (hinted !== undefined && hinted !== current && (OUTPUT_LIMIT_FIELDS as readonly string[]).includes(hinted)) {
    return hinted as OutputLimitField;
  }
  const others = OUTPUT_LIMIT_FIELDS.filter((name) => name !== current && mentionsParam(text, name));
  if (others.length === 0) return undefined;
  if (others.includes('max_completion_tokens')) return 'max_completion_tokens';
  return others[0];
}

const REASONING_FIELD: Record<Exclude<ReasoningWire, 'off'>, string> = {
  effort: 'reasoning_effort',
  object: 'reasoning',
  thinking: 'thinking',
  enable_thinking: 'enable_thinking',
};

/**
 * 推理开关：报文点名我们没在用的字段就改用它；只说当前字段不认识就关掉。
 * `reasoning` 和 `reasoning_effort` 用词边界分开，点名后者不会被当成前者。
 */
function nextReasoningWire(current: ReasoningWire, text: string): ReasoningWire | undefined {
  if (current === 'off') return undefined;
  const named = (Object.keys(REASONING_FIELD) as Array<Exclude<ReasoningWire, 'off'>>).find((wire) => {
    if (wire === current) return false;
    return mentionsParam(text, REASONING_FIELD[wire]);
  });
  if (named !== undefined) return named;
  if (!UNSUPPORTED_WORDS.some((word) => text.includes(word))) return undefined;
  if (mentionsParam(text, REASONING_FIELD[current])) return 'off';
  return undefined;
}

export function degradeRequestCaps(caps: RequestCaps, errorText: string): RequestCaps | undefined {
  const text = errorText.toLowerCase();

  const limit = nextOutputLimit(caps.outputLimit, text);
  if (limit !== undefined) return { ...caps, outputLimit: limit };
  // 旧模型拒 adaptive、新模型拒 budget_tokens。先于推理开关处理，避免 thinking 一词被抢走。
  if (!caps.adaptiveThinking && mentionsParam(text, 'budget_tokens') && text.includes('adaptive')) {
    return { ...caps, adaptiveThinking: true };
  }
  if (caps.adaptiveThinking && mentionsParam(text, 'thinking') && text.includes('adaptive') && text.includes('not supported')) {
    return { ...caps, adaptiveThinking: false };
  }
  const wire = nextReasoningWire(caps.reasoningWire, text);
  if (wire !== undefined) return { ...caps, reasoningWire: wire };
  if (caps.sendReasoning && text.includes('not issued to this caller')) {
    return { ...caps, sendReasoning: false };
  }

  if (!UNSUPPORTED_WORDS.some((word) => text.includes(word))) return undefined;

  if (mentionsParam(text, 'stream_options') && caps.streamOptions) {
    return { ...caps, streamOptions: false };
  }
  if (mentionsParam(text, 'store') && caps.sendStore) {
    return { ...caps, sendStore: false };
  }
  if (mentionsParam(text, 'encrypted_content') && caps.sendReasoning) {
    return { ...caps, sendReasoning: false };
  }
  if (mentionsParam(text, 'cache_control') && caps.promptCache) {
    return { ...caps, promptCache: false };
  }
  // 保留时间先降，因为它比 key 更少见；先降 key 会让「保留时间不支持」这条报文
  // 白跑一轮。两者都降完才算这个端点的缓存参数完全谈妥。
  if (mentionsParam(text, 'prompt_cache_retention') && caps.promptCacheRetention) {
    return { ...caps, promptCacheRetention: false };
  }
  if (mentionsParam(text, 'prompt_cache_key') && caps.promptCacheKey) {
    return { ...caps, promptCacheKey: false };
  }
  return undefined;
}


