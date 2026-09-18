/**
 * `models.json`：端点与模型的**声明**。人手写，程序只读。
 *
 * 为什么从 config.toml 里搬出来：`base_url` / `api_key` / `api` / `[compat]` 描述的是
 * 「这个端点长什么样」，而不是「sph 怎么工作」。分开之后 config.toml 只回答「用哪个
 * 端点」，端点自身的一切都在这里，一个端点写一次。
 *
 * 与 pi 的 models.json 的关系：结构与字段名对齐（`providers` / `baseUrl` / `apiKey` /
 * `models` / `contextWindow` / `maxTokens`），便于两边迁移。刻意**不支持**三样东西——
 * `!command`（等于从配置文件执行任意 shell，sph 有沙箱体系，不引入新的执行路径）、
 * `cost`（没有成本统计，没有消费者）、`modelOverrides`/`oauth`（sph 没有内置模型目录）。
 *
 * 解析一律 fail-closed：缺 provider、重复模型 id、字段类型错误都直接抛错。声明是手写
 * 文件，静默忽略一个拼错的字段，表现为「配置明明写了却不生效」，最难排查。
 */

import { existsSync, readFileSync } from 'node:fs';
import { isRecord } from '../util.js';
import { parseApiProtocol, parseCompat, type ApiProtocol } from './primitives.js';
import type { CompatProfile } from '../llm/compat.js';
import { ConfigError } from './errors.js';

/** 一个模型声明的容量与协议；`api` / `compat` 省略即继承 provider。 */
export interface ModelDeclaration {
  id: string;
  /** 展示名；省略时由 displayNameForModel 从 id 推导。 */
  name?: string;
  api?: ApiProtocol;
  compat?: CompatProfile;
  contextWindow?: number;
  maxTokens?: number;
}

export interface ProviderDeclaration {
  name: string;
  baseUrl: string;
  api: ApiProtocol;
  /** 已做 `$VAR` 插值；显式空串 = 免鉴权（靠 headers 识别会话）。 */
  apiKey: string;
  headers: Record<string, string>;
  compat?: CompatProfile;
  models: ModelDeclaration[];
}

export interface ModelRegistry {
  providers: ProviderDeclaration[];
}

/**
 * `$VAR` / `${VAR}` 插值；`$$` 输出字面 `$`。
 *
 * 只支持环境变量、不支持 `!command`：多端点之后「哪把 key 给哪个端点」必须一眼可见，
 * 而执行任意命令会把凭据来源变成运行时副作用。变量缺失即报错而不是留空串——空串在
 * 这个代码库里是「故意免鉴权」的意思，把配置错误静默成免鉴权是最坏的一种失败。
 */
export function interpolateEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch !== '$') {
      out += ch;
      continue;
    }
    const next = value[i + 1];
    if (next === '$') {
      out += '$';
      i++;
      continue;
    }
    if (next === '{') {
      const close = value.indexOf('}', i + 2);
      if (close < 0) throw new ConfigError(`unterminated \${...} in models.json: ${value}`);
      const name = value.slice(i + 2, close);
      out += requireEnv(name, env, value);
      i = close;
      continue;
    }
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(value.slice(i + 1));
    if (!match) {
      // 裸 `$` 不是变量起始（`$ ` 之类）：原样保留，别吃掉用户的内容。
      out += ch;
      continue;
    }
    out += requireEnv(match[0], env, value);
    i += match[0].length;
  }
  return out;
}

function requireEnv(name: string, env: NodeJS.ProcessEnv, source: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new ConfigError(`models.json references $${name} but it is not set (in: ${source})`);
  }
  return value;
}

export function parseRegistry(raw: unknown, env: NodeJS.ProcessEnv = process.env): ModelRegistry {
  if (!isRecord(raw)) throw new ConfigError('models.json must be a JSON object');
  const providersRaw = raw.providers;
  if (providersRaw === undefined) throw new ConfigError('models.json is missing "providers"');
  if (!isRecord(providersRaw)) throw new ConfigError('models.json "providers" must be an object');

  const providers: ProviderDeclaration[] = [];
  for (const [name, value] of Object.entries(providersRaw)) {
    providers.push(parseProvider(name, value, env));
  }
  if (providers.length === 0) throw new ConfigError('models.json declares no providers');
  return { providers };
}

function parseProvider(name: string, raw: unknown, env: NodeJS.ProcessEnv): ProviderDeclaration {
  if (!isRecord(raw)) throw new ConfigError(`models.json providers.${name} must be an object`);
  const baseUrl = requireString(raw.baseUrl, `providers.${name}.baseUrl`);
  // `api` 可以只写在模型级：那种 provider 是「同一网关下不同模型走不同协议」的形态。
  const providerApi = raw.api === undefined ? undefined : parseApi(raw.api, `providers.${name}.api`);
  const apiKeyRaw = raw.apiKey;
  if (apiKeyRaw !== undefined && typeof apiKeyRaw !== 'string') {
    throw new ConfigError(`providers.${name}.apiKey must be a string`);
  }
  const headers = parseHeaders(raw.headers, `providers.${name}.headers`, env);
  const compat = parseCompat(raw.compat, `providers.${name}.compat`);

  const modelsRaw = raw.models;
  if (!Array.isArray(modelsRaw)) {
    throw new ConfigError(`providers.${name}.models must be an array`);
  }

  const seen = new Set<string>();
  const models: ModelDeclaration[] = [];
  for (const [index, row] of modelsRaw.entries()) {
    const model = parseModel(row, `providers.${name}.models[${index}]`);
    if (seen.has(model.id)) {
      // 重复 id 的后果是「后写覆盖前写」，但用户看到的是两条一样的条目，改错一条不生效。
      throw new ConfigError(`providers.${name} declares model "${model.id}" twice`);
    }
    seen.add(model.id);
    models.push(model);
  }
  if (models.length === 0) throw new ConfigError(`providers.${name} declares no models`);
  if (providerApi === undefined && models.every((model) => model.api === undefined)) {
    throw new ConfigError(`providers.${name} needs "api" at provider or model level`);
  }

  return {
    name,
    baseUrl,
    // provider 级缺省时留空，由 resolveModel 从模型级补齐（见那里的注释）。
    api: providerApi ?? 'chat-completions',
    apiKey: apiKeyRaw === undefined ? '' : interpolateEnv(apiKeyRaw, env),
    headers,
    ...(compat === undefined ? {} : { compat }),
    models,
  };
}

function parseModel(raw: unknown, where: string): ModelDeclaration {
  if (!isRecord(raw)) throw new ConfigError(`${where} must be an object`);
  const id = requireString(raw.id, `${where}.id`);
  const name = raw.name === undefined ? undefined : requireString(raw.name, `${where}.name`);
  const api = raw.api === undefined ? undefined : parseApi(raw.api, `${where}.api`);
  const compat = parseCompat(raw.compat, `${where}.compat`);
  const contextWindow = parsePositiveInt(raw.contextWindow, `${where}.contextWindow`);
  const maxTokens = parsePositiveInt(raw.maxTokens, `${where}.maxTokens`);
  return {
    id,
    ...(name === undefined ? {} : { name }),
    ...(api === undefined ? {} : { api }),
    ...(compat === undefined ? {} : { compat }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  };
}

function parseApi(value: unknown, where: string): ApiProtocol {
  return parseApiProtocol(value, where);
}

function parsePositiveInt(value: unknown, where: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${where} must be a positive integer`);
  }
  return value;
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`${where} must be a non-empty string`);
  }
  return value.trim();
}

function parseHeaders(value: unknown, where: string, env: NodeJS.ProcessEnv): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new ConfigError(`${where} must be an object of strings`);
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new ConfigError(`${where}.${key} must be a non-empty string`);
    }
    out[key.trim()] = interpolateEnv(raw.trim(), env);
  }
  return out;
}

/** 读并解析 `models.json`；文件不存在或 JSON 坏掉都直接报错（它是必需配置）。 */
export function loadRegistry(path: string, env: NodeJS.ProcessEnv = process.env): ModelRegistry {
  if (!existsSync(path)) {
    throw new ConfigError(`models.json not found: ${path}\nDeclare your endpoints there (see: sph --help).`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`models.json is not valid JSON (${path}): ${reason}`);
  }
  return parseRegistry(parsed, env);
}

export function findProvider(registry: ModelRegistry, name: string): ProviderDeclaration {
  const provider = registry.providers.find((item) => item.name === name);
  if (!provider) {
    const known = registry.providers.map((item) => item.name).join(', ');
    throw new ConfigError(`unknown provider "${name}" in config.toml (models.json has: ${known})`);
  }
  return provider;
}

/** 一个模型解析后的生效参数：声明与全局兜底合并后的结果。 */
export interface ResolvedModel {
  provider: ProviderDeclaration;
  /** 传给 API 的模型 id。 */
  id: string;
  /** 展示名；未声明时为 undefined，调用方回落到 displayNameForModel(id)。 */
  name?: string;
  api: ApiProtocol;
  compat?: CompatProfile;
  contextWindow?: number;
  maxTokens?: number;
}

/**
 * 把模型声明与全局兜底合并成生效参数。
 *
 * 优先级 `api`：CLI `--api` > 模型级 > provider 级。`--api` 是最高的逃生口，因为它表达的
 * 是「我知道自己在干什么，这一个进程全按这个协议发」。
 *
 * `compat` 逐键浅合并（模型级赢）：与 pi 的语义一致，且 provider 级能作默认值。
 */
export function resolveModel(
  provider: ProviderDeclaration,
  modelId: string,
  options: { apiOverride?: ApiProtocol; env?: NodeJS.ProcessEnv } = {},
): ResolvedModel {
  const declared = provider.models.find((item) => item.id === modelId);
  const compat = mergeCompat(provider.compat, declared?.compat);
  return {
    provider,
    id: modelId,
    ...(declared?.name === undefined ? {} : { name: declared.name }),
    api: options.apiOverride ?? declared?.api ?? provider.api,
    ...(compat === undefined ? {} : { compat }),
    ...(declared?.contextWindow === undefined ? {} : { contextWindow: declared.contextWindow }),
    ...(declared?.maxTokens === undefined ? {} : { maxTokens: declared.maxTokens }),
  };
}

function mergeCompat(
  base: CompatProfile | undefined,
  override: CompatProfile | undefined,
): CompatProfile | undefined {
  if (base === undefined) return override;
  if (override === undefined) return base;
  return { ...base, ...override };
}

/**
 * 解析 `--model` 的 provider 限定形式 `provider/model`。
 *
 * 歧义处理：模型 id 本身可能含斜杠（`nvidia/deepseek-v4-flash`）。只有当第一个 `/`
 * 之前的部分**命中已声明的 provider 名**时才当限定，否则整串当模型 id——两种真实情况
 * 都不误判。
 */
export function splitProviderModel(
  providers: readonly ProviderDeclaration[],
  spec: string,
): { provider?: string; model: string } {
  const slash = spec.indexOf('/');
  if (slash <= 0) return { model: spec };
  const head = spec.slice(0, slash);
  if (!providers.some((item) => item.name === head)) return { model: spec };
  return { provider: head, model: spec.slice(slash + 1) };
}
