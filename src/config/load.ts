import { APPROVAL_MODES, type ApprovalMode } from '../approval/policy.js';
import { existsSync, readFileSync } from 'node:fs';
import { parse as parseToml } from 'smol-toml';
import { sphConfigPath } from '../home.js';
import { REASONING_EFFORTS, type ReasoningEffort } from '../llm/openai.js';
import { DEFAULT_SPILL_THRESHOLD } from '../runtime/spill.js';
import type { SandboxMode } from '../sandbox/types.js';

export interface McpServerConfigFile {
  name: string;
  command: string;
  args?: string[];
}

/** 上游 API 协议形态；决定请求端点、鉴权头与消息编码方式。 */
export const API_PROTOCOLS = ['chat-completions', 'responses', 'anthropic-messages'] as const;
export type ApiProtocol = (typeof API_PROTOCOLS)[number];

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
  /** 工具结果超过这个字符数就落盘，上下文只留预览与路径；0 表示关闭。 */
  spillThreshold: number;
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
# spill_threshold = 8192        # 工具结果超过该字符数就落盘，0 关闭
# [[mcp_servers]]
# name = "demo"
# command = "npx"
# args = ["-y", "demo-mcp"]
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

function asString(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`${key} must be a non-empty string`);
  }
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
  const fileKey = asString(file.api_key, 'api_key');
  const envKey = env.SPH_API_KEY?.trim();
  const apiKey = envKey || fileKey;
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
  let maxTokens: number | undefined;
  if (maxTokensRaw !== undefined) {
    if (typeof maxTokensRaw !== 'number' || !Number.isInteger(maxTokensRaw) || !Number.isFinite(maxTokensRaw) || maxTokensRaw < 1) {
      throw new ConfigError('max_tokens must be a positive integer');
    }
    maxTokens = maxTokensRaw;
  }

  if (!baseUrl || !model || !apiKey) {
    throw new ConfigError(
      `missing base_url, model, or API key.\nWrite ${path}:\n\n${CONFIG_EXAMPLE}\nSet SPH_API_KEY or api_key. SPH_API_KEY wins.`,
    );
  }

  const sandbox = options?.sandboxOverride ?? parseSandboxMode(asString(file.sandbox, 'sandbox'));
  const reasoningEffort = parseReasoningEffort(file.reasoning_effort);
  const approval = parseApprovalMode(file.approval);
  const api = parseApiProtocol(file.api);
  const mcpServers = parseMcpServers(file.mcp_servers);
  const compactModel = parseOptionalModel(file.compact_model, 'compact_model');
  const reviewModel = parseOptionalModel(file.review_model, 'review_model');
  const spillThreshold = parseSpillThreshold(file.spill_threshold);
  return {
    baseUrl, model, apiKey, contextWindow, maxTokens, sandbox, reasoningEffort, approval, api, mcpServers,
    compactModel, reviewModel, spillThreshold,
  };
}

/** 辅助模型名可选：空串与缺省同义（用主模型），非字符串才报错。 */
function parseOptionalModel(value: unknown, key: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`${key} must be a non-empty string`);
  }
  return value.trim();
}

/**
 * spill 阈值：正数开启，0 关闭，缺省用内置默认（8KB）。
 * 显式给 0 是「我知道自己在做什么」的表达，不该被缺省值覆盖。
 */
function parseSpillThreshold(value: unknown): number {
  if (value === undefined) return DEFAULT_SPILL_THRESHOLD;
  if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isFinite(value) || value < 0) {
    throw new ConfigError('spill_threshold must be a non-negative integer (0 disables spilling)');
  }
  return value;
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
    if (!name || !command) throw new ConfigError(`mcp_servers[${i}] needs name and command`);
    const args = rec.args;
    if (args !== undefined && (!Array.isArray(args) || args.some((item) => typeof item !== 'string'))) {
      throw new ConfigError(`mcp_servers[${i}].args must be a string array`);
    }
    return { name, command, args: args as string[] | undefined };
  });
}
