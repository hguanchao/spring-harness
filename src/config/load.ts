import { existsSync, readFileSync } from 'node:fs';
import { parse as parseToml } from 'smol-toml';
import {
  APPROVAL_MODES,
  type ApprovalMode,
  type PermissionRules,
  type SubagentApprovalPolicy,
} from '../permission/policy.js';
import { SUBAGENT_APPROVAL_POLICIES } from '../permission/policy.js';
import { sphConfigPath, sphModelsPath } from '../home.js';
import { DEFAULT_MAX_RETRIES, DEFAULT_SPILL_THRESHOLD, REASONING_EFFORTS, type ReasoningEffort } from '../llm/client.js';
import type { McpServerConfig, McpPreferences } from '../plugins/services.js';
import { type CompatProfile } from './primitives.js';
import type { SandboxMode } from '../sandbox/types.js';
import { ConfigError } from './errors.js';
import { API_PROTOCOLS, type ApiProtocol } from './primitives.js';
import { findProvider, loadRegistry, resolveModel, type ProviderDeclaration } from './registry.js';
import { parseGrants, parseRules, parseTrusted } from './state.js';

export { ConfigError, API_PROTOCOLS };
export type { ApiProtocol };

export type McpServerConfigFile = McpServerConfig;

/**
 * 辅助调用（压缩摘要 / auto 审批审查器）的端点选择。
 *
 * 只剩一个 provider 指针：端点本体（baseUrl/apiKey/api/headers）在 models.json 的
 * provider 声明里，config.toml 只回答「辅助调用用哪个 provider」。省略 = 与主端点同源。
 */
export interface AuxConfig {
  provider?: string;
}

/**
 * 解析完成的生效配置。
 *
 * `baseUrl` / `apiKey` / `httpHeaders` / `compat` / `api` 来自 models.json 里 provider
 * 指针指向的声明与当前模型的解析结果——config.toml 不再持有端点，它只回答「用哪个
 * provider 与模型」。模型级声明缺失的 `contextWindow` / `maxTokens` 由这里的全局值兜底。
 */
export interface SphConfig {
  /** models.json 里生效的 provider 名。 */
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  /** provider 级静态请求头；协议默认头同名时以它为准。 */
  httpHeaders: Record<string, string>;
  /** 当前模型生效的 compat（provider 级与模型级合并）。 */
  compat?: CompatProfile;
  /** 当前模型生效的协议。 */
  api: ApiProtocol;
  contextWindow: number;
  /** 单次输出的最大 Token；模型未声明且未配置时由协议默认（anthropic 8192）或端点决定。 */
  maxTokens?: number;
  sandbox: SandboxMode;
  reasoningEffort?: ReasoningEffort;
  /** 缺省审批模式；未配置时由 CLI 兜底为 ask。 */
  approval?: ApprovalMode;
  /** `[permissions]` 针对具体动作的长期规则；省略即无规则。 */
  permissions: PermissionRules;
  /**
   * 子代理的审批策略；省略按 `inherit`。
   *
   * `inherit` 复用父会话的审批器（含父会话已批准的授权），`strict` 让子代理 fail-closed：
   * 受审工具一律拒绝、不弹窗、不共享父会话的授权。
   */
  subagentApproval: SubagentApprovalPolicy;
  mcpServers: McpServerConfigFile[];
  /** 压缩摘要专用模型（aux provider 或主 provider 的模型 id）；省略则用主模型。 */
  compactModel?: string;
  /** auto 审批审查器专用模型；省略则用主模型。 */
  reviewModel?: string;
  /** 辅助调用走哪个 provider；省略 = 与主端点同源。 */
  aux?: AuxConfig;
  /** 工具结果超过这个字符数就落盘，上下文只留预览与路径；0 表示关闭。 */
  spillThreshold: number;
  /**
   * 出站代理 URL（覆盖 LLM 请求、web_search 等全部出网点）。
   * 三态：undefined 回退 HTTP(S)_PROXY 环境变量；显式 "" 强制直连；非空必须 http(s)。
   */
  proxy?: string;
  /** 子代理嵌套深度预算：0 禁止派生，默认 1 层，避免子代理再派子代理。 */
  subagentMaxDepth: number;
  /**
   * 一轮里的模型调用上限（config.toml 的 `max_turns`）。
   * 省略不限制。配了之后子会话在最后几步收束，到顶把已有正文作为失败结果交回。
   */
  maxTurns?: number;
  /**
   * Anthropic 协议打 prompt-cache 断点，默认开。
   * agent 每步都重发完整历史，缓存收益远大于一次性写入成本；端点不认这个字段时会在运行时
   * 自动降级（见 llm/compat.ts），所以只在明确要省掉缓存写入时才需要关掉。
   */
  promptCache: boolean;
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
   * 来自外部配置文件的 server 一概不写回原文件，启停只在
   * 这里叠一层覆盖。这样「读别人的配置」和「改别人的配置」被彻底分开——后者会带来意料
   * 之外的副作用，而且很难撤销。
   */
  mcpPreferences: McpPreferences;
  /**
   * 被关掉的插件名（`[plugins] disabled`）。
   *
   * 插件是可选能力，所以这里只有「关」没有「开」：默认全装，坏插件由装载失败自己暴露。
   * 关掉 MCP 就是 `disabled = ["sph-mcp"]`——它的工具与服务一并消失，这正是把 MCP 做成
   * 插件而不是核心能力的收益。
   */
  disabledPlugins: string[];
}

/**
 * 省略即关。同机围栏要显式打开：没装 bwrap / sandbox-exec 的机器也能启动，
 * 打开之后后端缺失则拒绝启动，而不是悄悄无围栏跑。
 */
export function parseSandboxMode(value: string | undefined): SandboxMode {
  if (value === undefined || value === '') return 'off';
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

/** 缺 provider / model / key 时拒绝启动，避免绑死供应商或空跑。 */
export function loadConfig(options?: {
  configPath?: string;
  /** models.json 的路径；测试注入临时文件。缺省用 `~/.sph/models.json`。 */
  registryPath?: string;
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

  const registry = loadRegistry(options?.registryPath ?? sphModelsPath(), env);
  const providerName = requireNonEmptyString(file.provider, 'provider');
  const provider: ProviderDeclaration = findProvider(registry, providerName);
  const model = requireNonEmptyString(file.model, 'model');

  // 端点全部来自 provider 声明；空 key + 无 headers 的组合仍然拒绝——那是免鉴权网关
  // 忘了写会话标识头的配置错误，启动时报错比第一轮请求 401 时报错好排查。
  if (provider.apiKey === '' && Object.keys(provider.headers).length === 0) {
    throw new ConfigError(
      `provider "${providerName}" has no apiKey and no headers. Set apiKey (or headers for keyless gateways).`,
    );
  }

  const resolved = resolveModel(provider, model);
  const contextRaw = file.context_window;
  let contextWindow = 256_000;
  if (contextRaw !== undefined) {
    if (typeof contextRaw !== 'number' || !Number.isFinite(contextRaw) || contextRaw < 1000) {
      throw new ConfigError('context_window must be a number >= 1000');
    }
    contextWindow = Math.floor(contextRaw);
  }

  // 输出上限可选：模型声明 > 配置文件 > 保持协议现状（未配置时 chat-completions/responses
  // 不发字段，anthropic 用默认 8192），避免为老配置无谓引入新约束。
  const maxTokensRaw = file.max_tokens;
  const configMaxTokens = maxTokensRaw === undefined
    ? undefined
    : requireInt(maxTokensRaw, 1, 'max_tokens must be a positive integer');
  const maxTokens = resolved.maxTokens ?? configMaxTokens;

  const proxy = parseProxy(file.proxy);

  const sandbox = options?.sandboxOverride ?? parseSandboxMode(asString(file.sandbox, 'sandbox'));
  const reasoningEffort = parseReasoningEffort(file.reasoning_effort);
  const approval = parseApprovalMode(file.approval);
  const permissions = parseRules(file.permissions);
  const subagentApproval = parseSubagentApproval(file.subagent_approval);
  const mcpServers = parseMcpServers(file.mcp_servers);
  const compactModel = parseOptionalModel(file.compact_model, 'compact_model');
  const reviewModel = parseOptionalModel(file.review_model, 'review_model');
  const aux = parseAux(file.aux);
  const spillThreshold = parseSpillThreshold(file.spill_threshold);
  const subagentMaxDepth = parseSubagentMaxDepth(file.subagent_max_depth);
  const maxTurns = parseMaxTurns(file.max_turns);
  const promptCache = parsePromptCache(file.prompt_cache);
  const maxSessionTokens = parseMaxSessionTokens(file.max_session_tokens);
  const maxRetries = parseMaxRetries(file.max_retries);
  const mcpPreferences = parseMcpPreferences(file.mcp);
  const disabledPlugins = parseDisabledPlugins(file.plugins);
  return {
    provider: providerName,
    model,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    httpHeaders: provider.headers,
    ...(resolved.compat === undefined ? {} : { compat: resolved.compat }),
    api: resolved.api,
    contextWindow: resolved.contextWindow ?? contextWindow,
    maxTokens,
    sandbox, reasoningEffort, approval, mcpServers,
    permissions, subagentApproval,
    compactModel, reviewModel, aux, spillThreshold, proxy, subagentMaxDepth, maxTurns, promptCache,
    maxSessionTokens, maxRetries, mcpPreferences, disabledPlugins,
  };
}

export function readTrustedGrants(path: string = sphConfigPath()): { trusted: string[]; grants: Record<string, string[]> } {
  if (!existsSync(path)) return { trusted: [], grants: {} };
  const parsed = parseToml(readFileSync(path, 'utf8')) as Record<string, unknown>;
  return { trusted: parseTrusted(parsed.trusted), grants: parseGrants(parsed.grants) };
}

/**
 * `[aux]` 表：只有一个 provider 指针，省略即同源。
 *
 * `compact_model` / `review_model` 是 aux provider（缺省即主 provider）里的模型 id，
 * 协议按该 provider 的声明解析——这正是旧 `sharesMainEndpoint` 逻辑的结构化表达。
 */
function parseAux(value: unknown): AuxConfig | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError('aux must be a table');
  }
  const row = value as Record<string, unknown>;
  if (row.provider === undefined || row.provider === '') return undefined;
  return { provider: requireNonEmptyString(row.provider, 'aux.provider') };
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
 * 子代理嵌套深度预算：非负整数，默认 1，防止子代理再往下派生。
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

/** 一轮的模型调用上限。省略不限制；0 没有意义，显式写 0 报错而不是悄悄关掉。 */
function parseMaxTurns(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  return requireInt(value, 1, 'max_turns must be a positive integer');
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
 * 审批模式可选。放在配置里是为了让 `/permission` 的选择能跨进程生效——
 * 在此之前它只能来自 `--approval` / `--yolo`，命令行一过就没了。
 */
export function parseApprovalMode(value: unknown): ApprovalMode | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !(APPROVAL_MODES as readonly string[]).includes(value)) {
    throw new ConfigError(`approval must be one of: ${APPROVAL_MODES.join(' | ')}`);
  }
  return value as ApprovalMode;
}

/** 推理档位可选；未配置时保持 undefined（请求不带 reasoning_effort，走服务端默认）。 */
export function parseReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !(REASONING_EFFORTS as readonly string[]).includes(value)) {
    throw new ConfigError(`reasoning_effort must be one of: ${REASONING_EFFORTS.join(' | ')}`);
  }
  return value as ReasoningEffort;
}

/** 子代理审批策略；省略默认 inherit——沿用既有行为，不静默改语义。 */
export function parseSubagentApproval(value: unknown): SubagentApprovalPolicy {
  if (value === undefined || value === '') return 'inherit';
  if (typeof value !== 'string' || !(SUBAGENT_APPROVAL_POLICIES as readonly string[]).includes(value)) {
    throw new ConfigError(`subagent_approval must be one of: ${SUBAGENT_APPROVAL_POLICIES.join(' | ')}`);
  }
  return value as SubagentApprovalPolicy;
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

function asString(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  return requireNonEmptyString(value, key);
}

/**
 * `[mcp]` 表：三个名字列表，缺省即空。
 *
 * 名字列表里出现不存在的 server 不算错误：配置可能来自别的机器或还没导入，静默忽略比
 * 拒绝启动合理。写成非数组才是真的写错了，那时候报错更省事。
 */
function parseMcpPreferences(value: unknown): McpPreferences {
  if (value === undefined) return { disabledServers: [], enabledServers: [], lazyServers: [] };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError('mcp must be a table');
  }
  const row = value as Record<string, unknown>;
  return {
    disabledServers: parseNameList(row.disabled_servers, 'mcp.disabled_servers', 'server names'),
    enabledServers: parseNameList(row.enabled_servers, 'mcp.enabled_servers', 'server names'),
    lazyServers: parseNameList(row.lazy_servers, 'mcp.lazy_servers', 'server names'),
  };
}

function parseNameList(value: unknown, key: string, noun: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConfigError(`${key} must be an array of ${noun}`);
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new ConfigError(`${key}[${index}] must be a non-empty string`);
    }
    return item.trim();
  });
}

/**
 * `[plugins] disabled`：关掉的插件名。
 *
 * 与 `[mcp] disabled_servers` 同一套语义——列出不存在的插件名不算错误（你可能只是还没把
 * 插件放进 `plugins/`），写成非数组才报错。
 */
function parseDisabledPlugins(value: unknown): string[] {
  if (value === undefined) return [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError('plugins must be a table');
  }
  return parseNameList((value as Record<string, unknown>).disabled, 'plugins.disabled', 'plugin names');
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
  if (!existsSync(path)) return { disabledServers: [], enabledServers: [], lazyServers: [] };
  try {
    const parsed: unknown = parseToml(readFileSync(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parseMcpPreferences((parsed as Record<string, unknown>).mcp);
  } catch {
    return undefined;
  }
}

function parseMcpTransport(value: unknown, key: string): 'stdio' | 'http' | 'sse' | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ConfigError(`${key} must be a string`);
  switch (value.trim().toLowerCase()) {
    case 'stdio':
      return 'stdio';
    case 'http':
    case 'streamable-http':
    case 'streamable_http':
      return 'http';
    case 'sse':
      return 'sse';
    default:
      throw new ConfigError(`${key} must be stdio, http, or sse`);
  }
}

function parseStringMap(value: unknown, key: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(`${key} must be a table of strings`);
  }
  const out: Record<string, string> = {};
  for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== 'string') throw new ConfigError(`${key}.${name} must be a string`);
    out[name] = item;
  }
  return out;
}

function parseMcpServers(value: unknown): McpServerConfigFile[] {
  if (value === undefined) return [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError('mcp_servers must be a table of tables ([mcp_servers.<name>])');
  }
  return Object.entries(value as Record<string, unknown>).map(([name, row]) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new ConfigError(`mcp_servers.${name} must be a table`);
    }
    const rec = row as Record<string, unknown>;
    const command = asString(rec.command, `mcp_servers.${name}.command`);
    const url = asString(rec.url, `mcp_servers.${name}.url`);
    if (!command && !url) throw new ConfigError(`mcp_servers.${name} needs a command or a url`);
    const args = rec.args;
    if (args !== undefined && (!Array.isArray(args) || args.some((item) => typeof item !== 'string'))) {
      throw new ConfigError(`mcp_servers.${name}.args must be a string array`);
    }
    const transport = parseMcpTransport(rec.type ?? rec.transport, `mcp_servers.${name}.type`);
    const headers = parseStringMap(rec.headers, `mcp_servers.${name}.headers`);
    const title = asString(rec.name, `mcp_servers.${name}.name`);
    return {
      name,
      ...(title !== undefined && title !== name ? { title } : {}),
      command,
      args: args as string[] | undefined,
      url,
      transport,
      headers,
    };
  });
}
