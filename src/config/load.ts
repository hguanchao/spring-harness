import { existsSync, readFileSync } from 'node:fs';
import { parse as parseToml } from 'smol-toml';
import { sphConfigPath } from '../home.js';
import { REASONING_EFFORTS, type ReasoningEffort } from '../llm/openai.js';
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
  api: ApiProtocol;
  mcpServers: McpServerConfigFile[];
}

export const CONFIG_EXAMPLE = `base_url = "https://api.example.com/v1"
model = "example-model"
# api_key = "..."
context_window = 256000
# max_tokens = 8192        # 单次输出上限（正整数，可选；未配置时走协议默认/端点默认）
sandbox = "workspace"
# api = "chat-completions"      # chat-completions | responses | anthropic-messages
# reasoning_effort = "medium"   # off | low | medium | high | xhigh | max
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
  const api = parseApiProtocol(file.api);
  const mcpServers = parseMcpServers(file.mcp_servers);
  return { baseUrl, model, apiKey, contextWindow, maxTokens, sandbox, reasoningEffort, api, mcpServers };
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
