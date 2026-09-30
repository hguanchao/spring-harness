import { existsSync, readFileSync } from 'node:fs';
import { parse as parseToml } from 'smol-toml';
import {
  APPROVAL_MODES,
  type ApprovalMode,
  type PermissionRules,
  type SubagentApprovalPolicy,
} from '../permission/policy.js';
import { SUBAGENT_APPROVAL_POLICIES, validateRules } from '../permission/policy.js';
import { sphConfigPath, sphModelsPath } from '../home.js';
import { DEFAULT_MAX_RETRIES, DEFAULT_SPILL_THRESHOLD } from '../llm/client.js';
import type { McpServerConfig } from '../plugins/services.js';
import {
  API_PROTOCOLS,
  NOTIFY_SETTINGS,
  parseSandboxMode,
  REASONING_EFFORTS,
  type ApiProtocol,
  type CompatProfile,
  type NotifySetting,
  type ReasoningEffort,
} from './primitives.js';
import type { SandboxMode } from '../sandbox/types.js';
import { ConfigError } from './errors.js';
import { loadRegistry, resolveModel, type ProviderDeclaration } from './registry.js';
import { parseGrants, parseRules, parseTrusted } from './state.js';

export { ConfigError, API_PROTOCOLS, parseSandboxMode };
export type { ApiProtocol, NotifySetting };

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
   * 沙箱内免问：`sandbox` 非 `off` 时，shell 命令不再逐条审批。
   *
   * 默认 false。sph 的沙箱是同主机文件策略、Windows 还只有部分强制，拿它当免问的依据比
   * 进程隔离弱，所以显式开启才生效（见 permission/policy.ts 的 sandboxCovers）。
   */
  sandboxAutoAllow: boolean;
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
   * 被关掉的插件名（`[plugins] disabled`）。
   *
   * 插件是可选能力，所以这里只有「关」没有「开」：默认全装，坏插件由装载失败自己暴露。
   * 关掉 MCP 就是 `disabled = ["sph-mcp"]`——它的工具与服务一并消失，这正是把 MCP 做成
   * 插件而不是核心能力的收益。
   */
  disabledPlugins: string[];
  /**
   * `[ui] notify`：任务完成时怎么提醒。默认 `auto`（响铃 + 终端接得到的桌面通知）。
   *
   * 只在界面侧读取；headless（`sph -p`）没有「等在外面的人」，不碰这个字段。
   */
  notify: NotifySetting;
  /**
   * `[ui] notify_after_seconds`：焦点仍在终端时，一段等待至少要跑够这么久才提醒。默认 10。
   *
   * `0` = 只要完成就提醒（不看焦点）。失焦时本字段不参与判定，一定提醒。
   */
  notifyAfterSeconds: number;
  /**
   * 端点指针对不上时的说明。
   *
   * provider / model 写错不再拒绝启动：首启模板和用户自己的 models.json 经常对不上，
   * 拒启动等于把 `/provider` 也挡住。这里记下原因，调用方打出来，实际请求改走一份能用的声明。
   */
  startupWarnings: readonly string[];
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
  // registry 先读：两份都缺时「models.json not found」是更根本的那条（正常流程下
  // 首启脚手架会把两份都生成，走到这里说明生成失败或被人为删掉）。
  const registry = loadRegistry(options?.registryPath ?? sphModelsPath(), env);
  let file: Record<string, unknown> = {};
  if (!existsSync(path)) {
    // 报错要把路径带出来，而不是只说「provider must be a non-empty string」。
    throw new ConfigError(`config.toml not found: ${path}\nIt must set provider and model pointers into models.json (see: sph --help).`);
  }
  const parsed: unknown = parseToml(readFileSync(path, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`invalid config file: ${path}`);
  }
  file = parsed as Record<string, unknown>;

  const writtenProvider = typeof file.provider === 'string' ? file.provider.trim() : '';
  const writtenModel = typeof file.model === 'string' ? file.model.trim() : '';
  const startupWarnings: string[] = [];
  // 指针对不上就改用 models.json 里的第一份声明，而不是退出。用户要能进 /provider 把指针改对。
  const provider = resolveConfiguredProvider(registry, writtenProvider, startupWarnings);
  const model = resolveConfiguredModel(provider, writtenModel, writtenProvider !== provider.name, startupWarnings);

  if (provider.apiKey === '' && Object.keys(provider.headers).length === 0) {
    startupWarnings.push(
      `provider "${provider.name}" has no apiKey and no headers. Set apiKey (or headers for keyless gateways).`,
    );
  }

  const resolved = resolveModel(provider, model);
  const contextWindow = readContextWindow(file.context_window, startupWarnings);

  // 输出上限可选：模型声明 > 配置文件 > 保持协议现状（未配置时 chat-completions/responses
  // 不发字段，anthropic 用默认 8192）。写错的数字丢掉，不挡启动。
  const configMaxTokens = readPositiveInt(file.max_tokens, 'max_tokens', startupWarnings);
  const maxTokens = resolved.maxTokens ?? configMaxTokens;

  const proxy = readProxy(file.proxy, startupWarnings);

  const sandbox = options?.sandboxOverride
    ?? readChoice(file.sandbox, 'sandbox', ['off', 'workspace', 'read-only'] as const, 'off', startupWarnings);
  const reasoningEffort = readChoice(
    file.reasoning_effort,
    'reasoning_effort',
    REASONING_EFFORTS,
    undefined,
    startupWarnings,
  );
  const approval = readChoice(file.approval, 'approval', APPROVAL_MODES, undefined, startupWarnings);
  const permissions = parseRules(file.permissions);
  validateRules(permissions, `permissions`, (message) => new ConfigError(message));
  const sandboxAutoAllow = readBool(file.sandbox_auto_allow, 'sandbox_auto_allow', false, startupWarnings);
  const subagentApproval = readChoice(
    file.subagent_approval,
    'subagent_approval',
    SUBAGENT_APPROVAL_POLICIES,
    'inherit',
    startupWarnings,
  );
  const mcpServers = readMcpServers(file.mcp_servers, startupWarnings);
  const compactModel = readDeclaredModel(file.compact_model, 'compact_model', provider, startupWarnings);
  const reviewModel = readDeclaredModel(file.review_model, 'review_model', provider, startupWarnings);
  const aux = readAux(file.aux, registry, startupWarnings);
  const spillThreshold = readInt(file.spill_threshold, 'spill_threshold', 0, DEFAULT_SPILL_THRESHOLD, startupWarnings);
  const subagentMaxDepth = readInt(file.subagent_max_depth, 'subagent_max_depth', 0, 1, startupWarnings);
  const maxTurns = readMaxTurns(file.max_turns, startupWarnings);
  const promptCache = readBool(file.prompt_cache, 'prompt_cache', true, startupWarnings);
  const maxSessionTokens = readInt(file.max_session_tokens, 'max_session_tokens', 0, 0, startupWarnings);
  const maxRetries = readInt(file.max_retries, 'max_retries', 0, DEFAULT_MAX_RETRIES, startupWarnings);
  const disabledPlugins = readDisabledPlugins(file.plugins, startupWarnings);
  const ui = readUiTable(file.ui, startupWarnings);
  const notify = readChoice(ui.notify, 'ui.notify', NOTIFY_SETTINGS, 'auto', startupWarnings);
  const notifyAfterSeconds = readInt(ui.notify_after_seconds, 'ui.notify_after_seconds', 0, 10, startupWarnings);
  return {
    provider: provider.name,
    model,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    httpHeaders: provider.headers,
    ...(resolved.compat === undefined ? {} : { compat: resolved.compat }),
    api: resolved.api,
    contextWindow: resolved.contextWindow ?? contextWindow,
    maxTokens,
    sandbox, reasoningEffort, approval, mcpServers,
    permissions, subagentApproval, sandboxAutoAllow,
    compactModel, reviewModel, aux, spillThreshold, proxy, subagentMaxDepth, maxTurns, promptCache,
    maxSessionTokens, maxRetries, disabledPlugins, notify, notifyAfterSeconds, startupWarnings,
  };
}

/**
 * config.toml 的 provider 指针。对不上时用登记表里的第一份，并说明原来写的是什么。
 */
function resolveConfiguredProvider(
  registry: ReturnType<typeof loadRegistry>,
  written: string,
  warnings: string[],
): ProviderDeclaration {
  if (written === '') {
    warnings.push('provider is not set in config.toml');
  } else {
    const found = registry.providers.find((item) => item.name === written);
    if (found !== undefined) return found;
    const known = registry.providers.map((item) => item.name).join(', ');
    warnings.push(`unknown provider "${written}" in config.toml (models.json has: ${known})`);
  }
  const fallback = registry.providers[0];
  if (fallback === undefined) throw new ConfigError('models.json declares no providers');
  warnings.push(`using provider "${fallback.name}" until config.toml points at one that exists`);
  return fallback;
}

/** 模型指针。换过 provider 之后，原来的模型 id 多半也不在新端点上，改用它的第一个模型。 */
function resolveConfiguredModel(
  provider: ProviderDeclaration,
  written: string,
  providerReplaced: boolean,
  warnings: string[],
): string {
  const declared = provider.models.find((item) => item.id === written);
  if (declared !== undefined) return declared.id;
  if (!providerReplaced && written !== '') return written;
  const fallback = provider.models[0]?.id ?? written;
  if (written === '') warnings.push(`model is not set in config.toml; using "${fallback}"`);
  else warnings.push(`model "${written}" is not declared by provider "${provider.name}"; using "${fallback}"`);
  return fallback;
}

export function readTrustedGrants(path: string = sphConfigPath()): { trusted: string[]; grants: Record<string, string[]> } {
  if (!existsSync(path)) return { trusted: [], grants: {} };
  const parsed = parseToml(readFileSync(path, 'utf8')) as Record<string, unknown>;
  return { trusted: parseTrusted(parsed.trusted), grants: parseGrants(parsed.grants) };
}

/** 写错就记一条并改用 fallback。省略（undefined / 空串）安静地用 fallback。 */
function note(warnings: string[], key: string, written: unknown, fallback: string): void {
  const shown = typeof written === 'string' ? `"${written}"` : JSON.stringify(written);
  warnings.push(`${key} ${shown} is invalid; using ${fallback}`);
}

/** 枚举键。fallback 为 undefined 时，写错等于没写。 */
function readChoice<T extends string>(
  value: unknown,
  key: string,
  allowed: readonly T[],
  fallback: T,
  warnings: string[],
): T;
function readChoice<T extends string>(
  value: unknown,
  key: string,
  allowed: readonly T[],
  fallback: undefined,
  warnings: string[],
): T | undefined;
function readChoice<T extends string>(
  value: unknown,
  key: string,
  allowed: readonly T[],
  fallback: T | undefined,
  warnings: string[],
): T | undefined {
  if (value === undefined || value === '') return fallback;
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  note(warnings, key, value, fallback === undefined ? 'the default' : `"${fallback}"`);
  return fallback;
}

/** 布尔键。加引号的 `"true"` 是常见笔误，当写错处理而不是当成真。 */
function readBool(value: unknown, key: string, fallback: boolean, warnings: string[]): boolean {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  note(warnings, key, value, String(fallback));
  return fallback;
}

/** 整数键。低于 min 或不是整数时用 fallback。 */
function readInt(value: unknown, key: string, min: number, fallback: number, warnings: string[]): number {
  if (value === undefined) return fallback;
  if (typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value) && value >= min) return value;
  note(warnings, key, value, String(fallback));
  return fallback;
}

/** 正整数，写错当没写（交给模型声明或协议默认）。 */
function readPositiveInt(value: unknown, key: string, warnings: string[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value) && value >= 1) return value;
  note(warnings, key, value, 'the model default');
  return undefined;
}

/** 全局上下文窗口。模型声明优先；这里写错就用内置 256000。 */
function readContextWindow(value: unknown, warnings: string[]): number {
  if (value === undefined) return 256_000;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1000) return Math.floor(value);
  note(warnings, 'context_window', value, '256000');
  return 256_000;
}

/** 一轮的模型调用上限。省略不限制；写 0 或负数没有「关掉」的语义，当没写。 */
function readMaxTurns(value: unknown, warnings: string[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value;
  note(warnings, 'max_turns', value, 'no limit');
  return undefined;
}

/**
 * `[aux]` 表：只有一个 provider 指针，省略或对不上即同源。
 *
 * `compact_model` / `review_model` 是 aux provider（缺省即主 provider）里的模型 id。
 */
function readAux(
  value: unknown,
  registry: ReturnType<typeof loadRegistry>,
  warnings: string[],
): AuxConfig | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    note(warnings, 'aux', value, 'the main provider');
    return undefined;
  }
  const written = (value as Record<string, unknown>).provider;
  if (written === undefined || written === '') return undefined;
  if (typeof written !== 'string' || !registry.providers.some((item) => item.name === written)) {
    const known = registry.providers.map((item) => item.name).join(', ');
    warnings.push(`aux.provider ${JSON.stringify(written)} is not in models.json (${known}); using the main provider`);
    return undefined;
  }
  return { provider: written };
}

/**
 * `[ui]` 表：界面行为。整段不是表就当没写，只记一条说明——界面配置不涉及安全边界，
 * 写错的代价不该是启动失败。
 */
function readUiTable(value: unknown, warnings: string[]): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    note(warnings, 'ui', value, 'the defaults');
    return {};
  }
  return value as Record<string, unknown>;
}

/** 辅助模型名。空着用主模型；写了却不在当前 provider 的声明里也当没写。 */
function readDeclaredModel(
  value: unknown,
  key: string,
  provider: ProviderDeclaration,
  warnings: string[],
): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') {
    note(warnings, key, value, 'the main model');
    return undefined;
  }
  const id = value.trim();
  if (provider.models.some((item) => item.id === id)) return id;
  warnings.push(`${key} "${id}" is not declared by provider "${provider.name}"; using the main model`);
  return undefined;
}

/**
 * 出站代理三态（与 api_key 的显式空串约定呼应）：
 * - 未配置 → 回退标准环境变量 HTTPS_PROXY / HTTP_PROXY（NO_PROXY 照常生效）；
 * - 显式 `""` → 强制直连——shell 里全局挂了代理、但上游本可直达时用它逃生；
 * - 非空 → 必须是 http(s) URL。写错（含 socks）忽略并警告，改走环境变量。
 */
function readProxy(value: unknown, warnings: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    note(warnings, 'proxy', value, 'the environment proxy');
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') return '';
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    note(warnings, 'proxy', value, 'the environment proxy');
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    note(warnings, 'proxy', value, 'the environment proxy');
    return undefined;
  }
  return trimmed;
}

/**
 * `[plugins] disabled`：关掉的插件名。
 *
 * 列出不存在的插件名不算错误（你可能只是还没把插件放进 `plugins/`）。整段写错当没关任何插件。
 */
function readDisabledPlugins(value: unknown, warnings: string[]): string[] {
  if (value === undefined) return [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    note(warnings, 'plugins', value, 'every plugin');
    return [];
  }
  const list = (value as Record<string, unknown>).disabled;
  if (list === undefined) return [];
  if (!Array.isArray(list)) {
    note(warnings, 'plugins.disabled', list, 'every plugin');
    return [];
  }
  const names = list.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
  if (names.length !== list.length) warnings.push('plugins.disabled has empty or non-string entries; those were dropped');
  return names.map((item) => item.trim());
}

/**
 * 用户自己的 `[mcp_servers]`。坏条目丢掉并警告，不挡启动——外部来源已经是这个待遇，
 * 自己这份配置不该更严。整段不是表时全部丢掉。
 */
function readMcpServers(value: unknown, warnings: string[]): McpServerConfigFile[] {
  if (value === undefined) return [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    note(warnings, 'mcp_servers', value, 'no servers from config.toml');
    return [];
  }
  const servers: McpServerConfigFile[] = [];
  for (const [name, row] of Object.entries(value as Record<string, unknown>)) {
    const parsed = readMcpServer(name, row, warnings);
    if (parsed !== undefined) servers.push(parsed);
  }
  return servers;
}

function readMcpServer(name: string, row: unknown, warnings: string[]): McpServerConfigFile | undefined {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    warnings.push(`mcp_servers.${name} is not a table; dropped`);
    return undefined;
  }
  const rec = row as Record<string, unknown>;
  const command = optionalString(rec.command);
  const url = optionalString(rec.url);
  if (command === undefined && url === undefined) {
    warnings.push(`mcp_servers.${name} needs a command or a url; dropped`);
    return undefined;
  }
  const args = rec.args;
  if (args !== undefined && (!Array.isArray(args) || args.some((item) => typeof item !== 'string'))) {
    warnings.push(`mcp_servers.${name}.args must be a string array; dropped`);
    return undefined;
  }
  const transport = readMcpTransport(rec.type ?? rec.transport, name, warnings);
  if (transport === 'invalid') return undefined;
  const headers = readStringMap(rec.headers, name, warnings);
  if (headers === 'invalid') return undefined;
  const title = optionalString(rec.name);
  let callTimeoutMs: number | undefined;
  if (rec.call_timeout_ms !== undefined) {
    if (typeof rec.call_timeout_ms !== 'number' || !Number.isFinite(rec.call_timeout_ms) || rec.call_timeout_ms <= 0) {
      warnings.push(`mcp_servers.${name}.call_timeout_ms must be a positive number; ignored`);
    } else {
      callTimeoutMs = rec.call_timeout_ms;
    }
  }
  return {
    name,
    ...(title !== undefined && title !== name ? { title } : {}),
    command,
    args: args as string[] | undefined,
    url,
    transport,
    headers,
    ...(callTimeoutMs === undefined ? {} : { callTimeoutMs }),
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function readMcpTransport(
  value: unknown,
  name: string,
  warnings: string[],
): 'stdio' | 'http' | 'sse' | undefined | 'invalid' {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    warnings.push(`mcp_servers.${name}.type must be stdio, http, or sse; dropped`);
    return 'invalid';
  }
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
      warnings.push(`mcp_servers.${name}.type "${value}" must be stdio, http, or sse; dropped`);
      return 'invalid';
  }
}

function readStringMap(
  value: unknown,
  name: string,
  warnings: string[],
): Record<string, string> | undefined | 'invalid' {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    warnings.push(`mcp_servers.${name}.headers must be a table of strings; dropped`);
    return 'invalid';
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== 'string') {
      warnings.push(`mcp_servers.${name}.headers.${key} must be a string; dropped`);
      return 'invalid';
    }
    out[key] = item;
  }
  return out;
}
