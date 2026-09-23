import { type CompatProfile, type SessionAffinityFormat } from '../../config/primitives.js';
import { HOST_OPENAI_API, HOST_OPENROUTER, isOpenAiApiHost, isOpenRouterHost } from '../../net/hosts.js';

/**
 * 请求参数容忍度（caps）：把「同一协议在不同端点上的参数差异」收敛成一组布尔位。
 *
 * 为什么单独成模块：`chat-completions` / `responses` 是两套协议，但**同一个协议在不同
 * 端点上的可接受参数并不相同**。三种已确认的真实差异：
 * - OpenAI 的 o 系列 / gpt-5 在 chat.completions 下只认 `max_completion_tokens`，
 *   发 `max_tokens` 直接 400；
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

/** 一次请求的参数形态。adapter 只读它来决定发什么字段，不感知它是猜的还是学来的。 */
export interface RequestCaps {
  /** chat.completions 的输出上限用 `max_completion_tokens` 而不是 `max_tokens`。 */
  maxCompletionTokens: boolean;
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
  maxCompletionTokens: false,
  streamOptions: true,
  sendStore: true,
  sendReasoning: true,
  promptCache: true,
  promptCacheKey: true,
  promptCacheRetention: true,
});

/**
 * 已知强制 `max_completion_tokens` 的模型名。
 *
 * 只在「去掉厂商前缀后的裸名」上匹配，因为网关的命名有两种常见形态：
 * `o3-mini` 与 `openai/o3-mini`。要求数字后跟 `-` 或结尾，避免把 `o3xxx` 这类
 * 无辜名字卷进来。
 */
const REQUIRES_MAX_COMPLETION_TOKENS = /^(o[1-9](-|$)|gpt-5(-|$))/;

/** `openai/o3-mini` → `o3-mini`。取最后一段，兼容网关的厂商前缀命名。 */
function bareModelName(model: string): string {
  const trimmed = model.trim().toLowerCase();
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function hostnameOf(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** 只认官方 OpenAI 域名。未知网关一律当兼容端点，不维护厂商表。 */
export function isOfficialOpenAI(baseUrl: string): boolean {
  const host = hostnameOf(baseUrl);
  if (host) return isOpenAiApiHost(host);
  return new RegExp(`(?:^|[/.])${HOST_OPENAI_API.replaceAll('.', '\\.')}(?:[:/]|$)`, 'i').test(baseUrl);
}

/** URL 推断亲和头格式：只把 OpenRouter 从默认 openai 形态里摘出来。 */
export function detectSessionAffinity(baseUrl: string): SessionAffinityFormat {
  const host = hostnameOf(baseUrl);
  if (host && isOpenRouterHost(host)) return 'openrouter';
  if (!host && new RegExp(HOST_OPENROUTER.replaceAll('.', '\\.'), 'i').test(baseUrl)) return 'openrouter';
  return 'openai';
}

export interface InitialCapsOptions {
  baseUrl?: string;
  compat?: CompatProfile;
}

/**
 * 首个请求的初始能力位。
 *
 * `promptCache` 来自配置，一票否决 Anthropic 断点与 OpenAI 系 cache 字段。
 * 未知 URL 默认不发 `prompt_cache_key` / `prompt_cache_retention`；
 * 只有官方 OpenAI API 主机才开 key。`[compat]` 覆盖推断。
 */
export function initialRequestCaps(
  model: string,
  promptCache: boolean,
  options: InitialCapsOptions = {},
): RequestCaps {
  const official = options.baseUrl !== undefined && isOfficialOpenAI(options.baseUrl);
  const override = options.compat;
  return {
    maxCompletionTokens: REQUIRES_MAX_COMPLETION_TOKENS.test(bareModelName(model)),
    streamOptions: override?.streamOptions ?? true,
    sendStore: true,
    sendReasoning: true,
    promptCache,
    promptCacheKey: promptCache && (override?.promptCacheKey ?? official),
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
export function degradeRequestCaps(caps: RequestCaps, errorText: string): RequestCaps | undefined {
  const text = errorText.toLowerCase();

  if (mentionsParam(text, 'max_completion_tokens') && !caps.maxCompletionTokens) {
    return { ...caps, maxCompletionTokens: true };
  }
  if (caps.sendReasoning && text.includes('not issued to this caller')) {
    return { ...caps, sendReasoning: false };
  }

  if (!UNSUPPORTED_WORDS.some((word) => text.includes(word))) return undefined;

  if (mentionsParam(text, 'max_tokens') && caps.maxCompletionTokens) {
    return { ...caps, maxCompletionTokens: false };
  }
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

/**
 * 网关不回 400、直接给空 SSE / 空完成时，按 OpenCode 兼容端点常见拒收顺序摘字段。
 *
 * 实测：同一条提示词在 OpenCode 能跑完，sph 在工具后下一跳拿到 empty body。
 * OpenCode 默认不发 `stream_options` / `prompt_cache_retention` / `prompt_cache_key`；
 * 部分中转对未知字段不报 400，而是 200 + 空 event-stream。报文里没有 unsupported 字样，
 * `degradeRequestCaps` 认不出来，只能按这个静默顺序剥。
 */
export function degradeSilentCompat(caps: RequestCaps): RequestCaps | undefined {
  if (caps.streamOptions) return { ...caps, streamOptions: false };
  if (caps.promptCacheRetention) return { ...caps, promptCacheRetention: false };
  if (caps.promptCacheKey) return { ...caps, promptCacheKey: false };
  return undefined;
}
