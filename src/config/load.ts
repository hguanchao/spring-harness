import { existsSync, readFileSync } from 'node:fs';
import { parse as parseToml } from 'smol-toml';
import { APPROVAL_MODES, type ApprovalMode } from '../approval/policy.js';
import { sphConfigPath } from '../home.js';
import {
  SESSION_AFFINITY_FORMATS,
  type CompatProfile,
  type SessionAffinityFormat,
} from '../llm/compat.js';
import { REASONING_EFFORTS, type ReasoningEffort } from '../llm/openai.js';
import { DEFAULT_MAX_RETRIES } from '../llm/retry.js';
import type { McpServerConfig } from '../mcp/hub.js';
import type { McpPreferences } from '../mcp/sources.js';
import { DEFAULT_SPILL_THRESHOLD } from '../runtime/spill.js';
import type { SandboxMode } from '../sandbox/types.js';

export type McpServerConfigFile = McpServerConfig;

/** 上游 API 协议形态；决定请求端点、鉴权头与消息编码方式。 */
export const API_PROTOCOLS = ['chat-completions', 'responses', 'anthropic-messages'] as const;
export type ApiProtocol = (typeof API_PROTOCOLS)[number];

/**
 * 辅助调用（压缩摘要 / auto 审批审查器）可选的独立端点。
 *
 * 动因：主模型可能是某个贵的旗舰，而压缩摘要与安全审查器只需要一个便宜模型——它们只读不写、
 * 输出格式固定。此前辅助调用只能复用主配置的 base_url / api_key / api，「便宜的辅助模型」
 * 于是只在同一端点内成立，跨厂商做不到。
 *
 * 三个字段都可省，各自回退主配置。
 */
export interface AuxConfig {
  baseUrl?: string;
  apiKey?: string;
  api?: ApiProtocol;
  /** 辅助端点自己的兼容声明；省略且跨端点时走该端点 URL 推断。 */
  compat?: CompatProfile;
}

export interface SphConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  contextWindow: number;
  /** 单次输出的最大 Token；未配置时由协议默认（anthropic 8192）或端点决定。 */
  maxTokens?: number;
  sandbox: SandboxMode;
  reasoningEffort?: ReasoningEffort;
  /** 缺省审批模式；未配置时由 CLI 兜底为 ask。 */
  approval?: ApprovalMode;
  api: ApiProtocol;
  mcpServers: McpServerConfigFile[];
  /** 压缩摘要专用模型（同一个 base_url/api_key）；省略则用主模型。 */
  compactModel?: string;
  /** auto 审批审查器专用模型；省略则用主模型。 */
  reviewModel?: string;
  /** 辅助调用可选的独立端点；省略则复用主端点。 */
  aux?: AuxConfig;
  /** 工具结果超过这个字符数就落盘，上下文只留预览与路径；0 表示关闭。 */
  spillThreshold: number;
  /** 附加到每个 LLM 请求的静态头；api_key 为空时由它承担免鉴权会话标识。 */
  httpHeaders: Record<string, string>;
  /**
   * 出站代理 URL（覆盖 LLM 请求、模型目录、web_search 等全部出网点）。
   * 三态：undefined 回退 HTTP(S)_PROXY 环境变量；显式 "" 强制直连；非空必须 http(s)。
   */
  proxy?: string;
  /** 子代理嵌套深度预算：0 禁止派生，默认 1 层（对齐 grok-build 的扁平代理树）。 */
  subagentMaxDepth: number;
  /**
   * Anthropic 协议打 prompt-cache 断点，默认开。
   * agent 每步都重发完整历史，缓存收益远大于一次性写入成本；端点不认这个字段时会在运行时
   * 自动降级（见 llm/compat.ts），所以只在明确要省掉缓存写入时才需要关掉。
   */
  promptCache: boolean;
  /**
   * 端点参数声明，覆盖 URL 推断。省略的字段仍走推断。
   * `prompt_cache = false` 会在组装 caps 时关掉缓存相关位，不看这里。
   */
  compat?: CompatProfile;
  /**
   * 会话累计 token 预算（prompt + completion，含子代理与压缩调用）。0 表示不限制（默认）。
   * 计数在会话折叠里，因此活过 resume；超限时在发起下一次调用**之前**中止本轮。
   */
  maxSessionTokens: number;
  /**
   * 上游请求失败后的最多重试次数（不含首次）。默认 {@link DEFAULT_MAX_RETRIES}。
   * 0 = 失败即停。只对 408/429/5xx、网络抖动、idle timeout、空响应生效。
   */
  maxRetries: number;
  /**
   * MCP 的本地启停偏好（`[mcp]` 段）。
   *
   * 来自外部工具配置（Claude / Codex / `.mcp.json`）的 server 一概不写回原文件，启停只在
   * 这里叠一层覆盖。这样「读别人的配置」和「改别人的配置」被彻底分开——后者会带来意料
   * 之外的副作用，而且很难撤销。
   */
  mcpPreferences: McpPreferences;
}

export const CONFIG_EXAMPLE = `base_url = "https://api.example.com/v1"
model = "example-model"
# api_key = "..."
context_window = 256000
# max_tokens = 8192        # 单次输出上限（正整数，可选；未配置时走协议默认/端点默认）
sandbox = "workspace"
# api = "chat-completions"      # chat-completions | responses | anthropic-messages
# reasoning_effort = "medium"   # off | low | medium | high | xhigh | max
# approval = "ask"              # ask | auto | yolo（/approval 的选择会写回这里）
# compact_model = ""            # 压缩摘要用的便宜模型；留空用主模型
# review_model = ""             # auto 审批审查器用的模型；留空用主模型
# [aux]                         # 辅助调用（压缩摘要 / auto 审查器）走另一个端点；
#                               # 整段省略则复用主配置。三个字段都可单独省略。
# base_url = "https://api.deepseek.com/v1"
# api_key = "..."
# api = "chat-completions"      # chat-completions | responses | anthropic-messages
# spill_threshold = 8192        # 工具结果超过该字符数就落盘，0 关闭
# subagent_max_depth = 1        # 子代理嵌套深度预算；0 禁止派生，默认 1（扁平，子代理不再派生）
# prompt_cache = true           # Anthropic 打 prompt-cache 断点，默认开；端点不认时自动降级
# max_session_tokens = 0        # 会话累计 token 预算（含子代理/压缩调用）；0 = 不限制
# max_retries = 10              # 上游失败重试次数（不含首次）；0 = 失败即停
# proxy = "http://127.0.0.1:7890"  # 出站代理；显式 "" = 强制直连，缺省回退 HTTP(S)_PROXY 环境变量
# [compat]                      # 端点参数声明；省略按 base_url 推断（未知网关不发 cache key）
# prompt_cache_key = true       # 发 session 路由键；官方 api.openai.com 默认开
# prompt_cache_retention = true # 发 prompt_cache_retention = "24h"；默认关
# stream_options = false        # 关掉 stream_options.include_usage
# session_affinity = "openrouter"  # openai | openrouter | off
# [http_headers]                # 附加到每个 LLM 请求的静态头；api_key = ""（显式空）时免鉴权
# "User-Agent" = "opencode/1.4.3"
# "X-Opencode-Session" = "some-session-id"
# [[mcp_servers]]
# name = "demo"
# command = "npx"
# args = ["-y", "demo-mcp"]
# [mcp]                         # MCP 本地启停偏好；外部来源（Claude/Codex/.mcp.json）只读，
#                               # 开关记在这里，不改那些文件
# disabled_servers = ["demo"]   # 本地关掉；对任何来源都生效
# enabled_servers = []          # 本地打开某个来源自己声明关掉的 server
#                               # 其余来源按优先级读取：Claude > Codex > .mcp.json
`;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function parseSandboxMode(value: string | undefined): SandboxMode {
  if (value === undefined || value === '') return 'workspace';
  if (value === 'off' || value === 'workspace' || value === 'read-only') return value;
  throw new ConfigError(`unknown sandbox mode: ${value} (off | workspace | read-only)`);
}

/** 非空字符串校验；调用方已自行处理 undefined / 空串的省略语义。 */
function requireNonEmptyString(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`${key} must be a non-empty string`);
  }
  return value.trim();
}

function asString(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  return requireNonEmptyString(value, key);
}

/** 鉴权 key 可选：普通中转站必须配 key；免鉴权网关（靠 http_headers 里的客户端标识识别会话）
 * 用显式 `api_key = ""` 表达「不发 Authorization」。undefined、空串、纯空白同义于空。
 */
function asOptionalKey(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ConfigError(`${key} must be a string`);
  return value.trim();
}

/** 缺 base_url / model / key 时拒绝启动，避免绑死供应商或空跑。 */
export function loadConfig(options?: {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  sandboxOverride?: SandboxMode;
}): SphConfig {
  const env = options?.env ?? process.env;
  const path = options?.configPath ?? sphConfigPath();
  let file: Record<string, unknown> = {};
  if (existsSync(path)) {
    const parsed: unknown = parseToml(readFileSync(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ConfigError(`invalid config file: ${path}`);
    }
    file = parsed as Record<string, unknown>;
  }

  const baseUrl = asString(file.base_url, 'base_url');
  const model = asString(file.model, 'model');
  // key 三态：env 显式配置 > 文件普通值；文件里显式 `""` 表示不发鉴权头（由 http_headers 承担会话识别）。
  const fileKey = asOptionalKey(file.api_key, 'api_key');
  const envKey = env.SPH_API_KEY?.trim();
  const apiKey = envKey || fileKey || '';
  const contextRaw = file.context_window;
  let contextWindow = 256_000;
  if (contextRaw !== undefined) {
    if (typeof contextRaw !== 'number' || !Number.isFinite(contextRaw) || contextRaw < 1000) {
      throw new ConfigError('context_window must be a number >= 1000');
    }
    contextWindow = Math.floor(contextRaw);
  }

  // 输出上限可选：未配置时保持协议现状（chat-completions/responses 不发字段，anthropic 用默认 8192），
  // 避免为老配置无谓引入新约束。
  const maxTokensRaw = file.max_tokens;
  const maxTokens = maxTokensRaw === undefined
    ? undefined
    : requireInt(maxTokensRaw, 1, 'max_tokens must be a positive integer');

  const httpHeaders = parseHttpHeaders(file.http_headers);
  const proxy = parseProxy(file.proxy);

  if (!baseUrl || !model || (!apiKey && Object.keys(httpHeaders).length === 0)) {
    throw new ConfigError(
      `missing base_url, model, or API key.\nWrite ${path}:\n\n${CONFIG_EXAMPLE}\nSet SPH_API_KEY or api_key ("" + [http_headers] for keyless gateways). SPH_API_KEY wins.`,
    );
  }

  const sandbox = options?.sandboxOverride ?? parseSandboxMode(asString(file.sandbox, 'sandbox'));
  const reasoningEffort = parseReasoningEffort(file.reasoning_effort);
  const approval = parseApprovalMode(file.approval);
  const api = parseApiProtocol(file.api);
  const mcpServers = parseMcpServers(file.mcp_servers);
  const compactModel = parseOptionalModel(file.compact_model, 'compact_model');
  const reviewModel = parseOptionalModel(file.review_model, 'review_model');
  const aux = parseAux(file.aux);
  const spillThreshold = parseSpillThreshold(file.spill_threshold);
  const subagentMaxDepth = parseSubagentMaxDepth(file.subagent_max_depth);
  const promptCache = parsePromptCache(file.prompt_cache);
  const compat = parseCompat(file.compat, 'compat');
  const maxSessionTokens = parseMaxSessionTokens(file.max_session_tokens);
  const maxRetries = parseMaxRetries(file.max_retries);
  const mcpPreferences = parseMcpPreferences(file.mcp);
  return {
    baseUrl, model, apiKey, contextWindow, maxTokens, sandbox, reasoningEffort, approval, api, mcpServers,
    compactModel, reviewModel, aux, spillThreshold, httpHeaders, proxy, subagentMaxDepth, promptCache,
    compat, maxSessionTokens, maxRetries, mcpPreferences,
  };
}

/**
 * `[mcp]` 表：只认两个名字列表，缺省即空。
 *
 * 名字列表里出现不存在的 server 不算错误：配置可能来自别的机器或还没导入，静默忽略比
 * 拒绝启动合理。写成非数组才是真的写错了，那时候报错更省事。
 */
function parseMcpPreferences(value: unknown): McpPreferences {
  if (value === undefined) return { disabledServers: [], enabledServers: [] };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError('mcp must be a table');
  }
  const row = value as Record<string, unknown>;
  return {
    disabledServers: parseServerNameList(row.disabled_servers, 'mcp.disabled_servers'),
    enabledServers: parseServerNameList(row.enabled_servers, 'mcp.enabled_servers'),
  };
}

function parseServerNameList(value: unknown, key: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConfigError(`${key} must be an array of server names`);
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new ConfigError(`${key}[${index}] must be a non-empty string`);
    }
    return item.trim();
  });
}

/**
 * 单独读 `[mcp]` 段。
 *
 * `/mcps` 写完启停偏好后需要就地刷新内存里的那份，而重新 `loadConfig` 会顺带重跑
 * 一堆与 MCP 无关的校验（缺 key 直接抛错），在一次交互中途是不合适的。
 *
 * 读不回来（文件没了/被改坏）返回 undefined，调用方保持旧值——偏好刚写完，此时用空值
 * 覆盖只会让用户刚做的开关凭空消失。
 */
export function readMcpPreferences(path: string): McpPreferences | undefined {
  if (!existsSync(path)) return { disabledServers: [], enabledServers: [] };
  try {
    const parsed: unknown = parseToml(readFileSync(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parseMcpPreferences((parsed as Record<string, unknown>).mcp);
  } catch {
    return undefined;
  }
}

/**
 * `[aux]` 表：三个字段全可选，全缺时返回 undefined（等价于「复用主端点」）。
 *
 * `api` 要区分「没写」与「写了默认值」：`parseApiProtocol` 对缺省会回填
 * chat-completions，那会让 aux 悄悄锁死协议而不跟随主配置，所以这里只在显式给出时才取值。
 */
function parseAux(value: unknown): AuxConfig | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError('aux must be a table');
  }
  const row = value as Record<string, unknown>;
  const aux: AuxConfig = {};
  const baseUrl = asString(row.base_url, 'aux.base_url');
  if (baseUrl !== undefined) aux.baseUrl = baseUrl;
  // 与顶层 api_key 同一套三态语义：显式空串 = 该端点免鉴权。
  const apiKey = asOptionalKey(row.api_key, 'aux.api_key');
  if (apiKey !== undefined) aux.apiKey = apiKey;
  if (row.api !== undefined && row.api !== '') aux.api = parseApiProtocol(row.api);
  const compat = parseCompat(row.compat, 'aux.compat');
  if (compat !== undefined) aux.compat = compat;
  return Object.keys(aux).length > 0 ? aux : undefined;
}

function parseOptionalBoolean(value: unknown, key: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new ConfigError(`${key} must be a boolean`);
  return value;
}

/** `[compat]`：省略的字段走 URL 推断；空表等价于未配置。 */
function parseCompat(value: unknown, key: string): CompatProfile | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(`${key} must be a table`);
  }
  const row = value as Record<string, unknown>;
  const profile: CompatProfile = {};
  const promptCacheKey = parseOptionalBoolean(row.prompt_cache_key, `${key}.prompt_cache_key`);
  if (promptCacheKey !== undefined) profile.promptCacheKey = promptCacheKey;
  const promptCacheRetention = parseOptionalBoolean(row.prompt_cache_retention, `${key}.prompt_cache_retention`);
  if (promptCacheRetention !== undefined) profile.promptCacheRetention = promptCacheRetention;
  const streamOptions = parseOptionalBoolean(row.stream_options, `${key}.stream_options`);
  if (streamOptions !== undefined) profile.streamOptions = streamOptions;
  if (row.session_affinity !== undefined) {
    if (typeof row.session_affinity !== 'string') {
      throw new ConfigError(`${key}.session_affinity must be openai | openrouter | off`);
    }
    const affinity = row.session_affinity.trim();
    if (!(SESSION_AFFINITY_FORMATS as readonly string[]).includes(affinity)) {
      throw new ConfigError(`${key}.session_affinity must be openai | openrouter | off`);
    }
    profile.sessionAffinity = affinity as SessionAffinityFormat;
  }
  return Object.keys(profile).length > 0 ? profile : undefined;
}

/** 会话 token 预算：非负整数，0 = 不限制（默认）。 */
function parseMaxSessionTokens(value: unknown): number {
  if (value === undefined) return 0;
  return requireInt(value, 0, 'max_session_tokens must be a non-negative integer (0 disables the budget)');
}

/** 上游失败重试：非负整数，缺省 {@link DEFAULT_MAX_RETRIES}，0 = 失败即停。 */
function parseMaxRetries(value: unknown): number {
  if (value === undefined) return DEFAULT_MAX_RETRIES;
  return requireInt(value, 0, 'max_retries must be a non-negative integer (0 fails immediately)');
}

/** prompt-cache 断点开关：默认开，只有显式 false 才关。 */
function parsePromptCache(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'boolean') throw new ConfigError('prompt_cache must be a boolean');
  return value;
}

/**
 * 子代理嵌套深度预算：非负整数，默认 1（对齐 grok-build 的扁平代理树，防止失控派生）。
 * 0 = 完全禁止派生；超出预算的调用在运行时被拒——工具保持对子代理可见，
 * 由运行时策略统一负责拒绝，schema 不做裁剪。
 */
function requireInt(value: unknown, min: number, message: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isFinite(value) || value < min) {
    throw new ConfigError(message);
  }
  return value;
}

function parseSubagentMaxDepth(value: unknown): number {
  if (value === undefined) return 1;
  return requireInt(value, 0, 'subagent_max_depth must be a non-negative integer (0 forbids delegation)');
}

/** 辅助模型名可选：空串与缺省同义（用主模型），非字符串才报错。 */
function parseOptionalModel(value: unknown, key: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  return requireNonEmptyString(value, key);
}

/**
 * spill 阈值：正数开启，0 关闭，缺省用内置默认（8KB）。
 * 显式给 0 是「我知道自己在做什么」的表达，不该被缺省值覆盖。
 */
function parseSpillThreshold(value: unknown): number {
  if (value === undefined) return DEFAULT_SPILL_THRESHOLD;
  return requireInt(value, 0, 'spill_threshold must be a non-negative integer (0 disables spilling)');
}

/**
 * 审批模式可选。放在配置里是为了让 `/approval` 的选择能跨进程生效——
 * 在此之前它只能来自 `--approval` / `--yolo`，命令行一过就没了。
 */
export function parseApprovalMode(value: unknown): ApprovalMode | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !(APPROVAL_MODES as readonly string[]).includes(value)) {
    throw new ConfigError(`approval must be one of: ${APPROVAL_MODES.join(' | ')}`);
  }
  return value as ApprovalMode;
}

/** 上游协议可选；未配置默认 chat-completions（兼容所有 OpenAI 形态端点）。 */
export function parseApiProtocol(value: unknown): ApiProtocol {
  if (value === undefined || value === '') return 'chat-completions';
  if (typeof value !== 'string' || !(API_PROTOCOLS as readonly string[]).includes(value)) {
    throw new ConfigError(`api must be one of: ${API_PROTOCOLS.join(' | ')}`);
  }
  return value as ApiProtocol;
}

/**
 * 出站代理三态（与 api_key 的显式空串约定呼应）：
 * - 未配置 → 回退标准环境变量 HTTPS_PROXY / HTTP_PROXY（NO_PROXY 照常生效）；
 * - 显式 `""` → 强制直连——shell 里全局挂了代理、但上游本可直达时用它逃生；
 * - 非空 → 必须是 http(s) URL。undici 的代理不支持 socks，这里提前拦下，
 *   免得用户配了 socks5 却只看到一条莫名的连接错误。
 */
function parseProxy(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ConfigError('proxy must be a string');
  const trimmed = value.trim();
  if (trimmed === '') return '';
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ConfigError('proxy must be an http(s) URL (e.g. http://127.0.0.1:7890)');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError('proxy must be an http(s) URL (socks is not supported)');
  }
  return trimmed;
}

/** 自定义静态请求头可选：全表每项都必须是字符串，格式不对整体拒绝启动。 */
function parseHttpHeaders(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError('http_headers must be a table of string values');
  }
  const headers: Record<string, string> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!name.trim() || typeof raw !== 'string' || raw.trim() === '') {
      throw new ConfigError(`http_headers[${name}] must be a non-empty string`);
    }
    headers[name.trim()] = raw.trim();
  }
  return headers;
}

/** 推理档位可选；未配置时保持 undefined（请求不带 reasoning_effort，走服务端默认）。 */
export function parseReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !(REASONING_EFFORTS as readonly string[]).includes(value)) {
    throw new ConfigError(`reasoning_effort must be one of: ${REASONING_EFFORTS.join(' | ')}`);
  }
  return value as ReasoningEffort;
}

function parseMcpServers(value: unknown): McpServerConfigFile[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConfigError('mcp_servers must be an array');
  return value.map((row, i) => {
    if (!row || typeof row !== 'object') throw new ConfigError(`mcp_servers[${i}] must be a table`);
    const rec = row as Record<string, unknown>;
    const name = asString(rec.name, `mcp_servers[${i}].name`);
    const command = asString(rec.command, `mcp_servers[${i}].command`);
    const url = asString(rec.url, `mcp_servers[${i}].url`);
    if (!name || (!command && !url)) {
      throw new ConfigError(`mcp_servers[${i}] needs name and a command or url`);
    }
    const args = rec.args;
    if (args !== undefined && (!Array.isArray(args) || args.some((item) => typeof item !== 'string'))) {
      throw new ConfigError(`mcp_servers[${i}].args must be a string array`);
    }
    return { name, command, args: args as string[] | undefined, url };
  });
}
