/**
 * `models.json`：端点与模型的**声明**。人手写，程序只读。
 *
 * 为什么从 config.toml 里搬出来：`base_url` / `api_key` / `api` / `[compat]` 描述的是
 * 「这个端点长什么样」，而不是「sph 怎么工作」。分开之后 config.toml 只回答「用哪个
 * 端点」，端点自身的一切都在这里，一个端点写一次。
 *
 * 字段是 `providers` / `baseUrl` / `apiKey` / `models` / `contextWindow` / `maxTokens`，
 * 模型级还接受 `cost`（每百万 token 单价，声明了才折算花费）、`reasoning`、`input`
 * （能力声明，见 ModelDeclaration）。刻意不支持两样东西：`!command`（等于从配置文件
 * 执行任意 shell）、`oauth`（没有内置登录目录）。
 *
 * 解析一律 fail-closed：缺 provider、重复模型 id、字段类型错误都直接抛错。声明是手写
 * 文件，静默忽略一个拼错的字段，表现为「配置明明写了却不生效」，最难排查。
 */

import { existsSync, readFileSync } from 'node:fs';
import { isRecord } from '../util.js';
import { writeAtomically } from './save.js';
import { parseApiProtocol, parseCompat, type ApiProtocol } from './primitives.js';
import type { CompatProfile } from './primitives.js';
import type { ModelCostRates } from '../llm/client.js';
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
  /**
   * 每百万 token 的美元单价。声明了它，用量事件与会话统计才会折算出美元花费；
   * 不声明就只有 token 数——「不知道价格」和「免费」是两回事，宁可缺省。
   */
  cost?: ModelCostRates;
  /**
   * 模型是否支持推理档位。`false` 是唯一有行为的取值：配置的 reasoning_effort
   * 不再发送，省掉一次「发了 → 400 → 降级 → 重发」的往返。省略 = 不干预，
   * 交给既有链路（显式 off / 端点报文降级）。
   */
  reasoning?: boolean;
  /**
   * 模型接受的输入模态。缺省视为全收；声明里没有 `image` 时，图片附件在发送前
   * 降级成一条说明文本——模型知道「图存在但我看不到」，而不是对着 8MB base64 吃 400。
   */
  input?: readonly ('text' | 'image')[];
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
  const cost = parseCost(raw.cost, `${where}.cost`);
  const reasoning = raw.reasoning === undefined ? undefined : parseBoolean(raw.reasoning, `${where}.reasoning`);
  const input = parseInputModalities(raw.input, `${where}.input`);
  return {
    id,
    ...(name === undefined ? {} : { name }),
    ...(api === undefined ? {} : { api }),
    ...(compat === undefined ? {} : { compat }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(cost === undefined ? {} : { cost }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(input === undefined ? {} : { input }),
  };
}

/**
 * `cost`：四项单价必须成组声明。价格数据抄自 models.dev 或厂商定价页，四项都抄得到；
 * 只填一半会让「缓存 token 按什么价」变成猜，猜错就是静默多算或少算钱。
 */
function parseCost(value: unknown, where: string): ModelCostRates | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new ConfigError(`${where} must be an object`);
  const rates: ModelCostRates = {
    input: requireRate(value.input, `${where}.input`),
    output: requireRate(value.output, `${where}.output`),
    cacheRead: requireRate(value.cacheRead, `${where}.cacheRead`),
    cacheWrite: requireRate(value.cacheWrite, `${where}.cacheWrite`),
  };
  return rates;
}

function requireRate(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ConfigError(`${where} must be a non-negative number (USD per million tokens)`);
  }
  return value;
}

function parseBoolean(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') throw new ConfigError(`${where} must be a boolean`);
  return value;
}

const INPUT_MODALITIES = ['text', 'image'] as const;

function parseInputModalities(value: unknown, where: string): readonly ('text' | 'image')[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConfigError(`${where} must be a non-empty array of "text" / "image"`);
  }
  for (const item of value) {
    if (!(INPUT_MODALITIES as readonly string[]).includes(item)) {
      throw new ConfigError(`${where} accepts only "text" / "image", got: ${JSON.stringify(item)}`);
    }
  }
  return value as readonly ('text' | 'image')[];
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

/**
 * 向某个 provider 追加一条模型声明并原子写回 models.json。
 *
 * 这是 `/provider` 向导「选了未声明的模型就追加」的写入口。刻意不走 parseRegistry：
 * 那条路径会把 `$VAR` 插值成真实值再写回，等于把凭据烙进文件——这里只动目标 provider
 * 的 models 数组，其余字节原样保留（整体重新序列化为 2 空格 JSON，models.json 本来就
 * 是无注释的纯 JSON，不存在 TOML 那种注释保真问题）。
 *
 * id 已存在时不动文件：重复声明没有意义，静默返回让调用方继续切模型。
 */
export function appendModelDeclaration(
  path: string,
  providerName: string,
  modelId: string,
  options: { name?: string; contextWindow?: number; maxTokens?: number } = {},
): void {
  if (!existsSync(path)) {
    throw new ConfigError(`models.json not found: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`models.json is not valid JSON (${path}): ${reason}`);
  }
  if (!isRecord(parsed) || !isRecord(parsed.providers)) {
    throw new ConfigError(`models.json has no providers table: ${path}`);
  }
  const provider = (parsed.providers as Record<string, unknown>)[providerName];
  if (!isRecord(provider)) {
    throw new ConfigError(`unknown provider "${providerName}" in models.json`);
  }
  if (!Array.isArray(provider.models)) {
    throw new ConfigError(`providers.${providerName}.models must be an array in models.json`);
  }
  const declared = provider.models.some(
    (row) => isRecord(row) && (row as Record<string, unknown>).id === modelId,
  );
  if (declared) return;
  provider.models.push({ id: modelId, ...options });
  // 结尾换行保持与手写文件的惯例一致；解析不依赖它。
  writeAtomically(path, `${JSON.stringify(parsed, null, 2)}\n`);
}

/**
 * 把模型的生效协议写进 models.json（模型级覆盖 provider 级）。
 *
 * `/provider` 向导最后一步用：已有声明就改 `api`，没有就追加。同样不走 parseRegistry，
 * 避免把 `$VAR` 凭据烙回文件。
 */
export function upsertModelApi(
  path: string,
  providerName: string,
  modelId: string,
  api: ApiProtocol,
): void {
  if (!existsSync(path)) {
    throw new ConfigError(`models.json not found: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`models.json is not valid JSON (${path}): ${reason}`);
  }
  if (!isRecord(parsed) || !isRecord(parsed.providers)) {
    throw new ConfigError(`models.json has no providers table: ${path}`);
  }
  const provider = (parsed.providers as Record<string, unknown>)[providerName];
  if (!isRecord(provider)) {
    throw new ConfigError(`unknown provider "${providerName}" in models.json`);
  }
  if (!Array.isArray(provider.models)) {
    throw new ConfigError(`providers.${providerName}.models must be an array in models.json`);
  }
  const row = provider.models.find((item) => isRecord(item) && item.id === modelId);
  if (isRecord(row)) {
    row.api = api;
  } else {
    provider.models.push({ id: modelId, api });
  }
  writeAtomically(path, `${JSON.stringify(parsed, null, 2)}\n`);
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
  cost?: ModelCostRates;
  reasoning?: boolean;
  input?: readonly ('text' | 'image')[];
}

/**
 * 把模型声明与全局兜底合并成生效参数。
 *
 * 优先级 `api`：CLI `--api` > 模型级 > provider 级。`--api` 是最高的逃生口，因为它表达的
 * 是「我知道自己在干什么，这一个进程全按这个协议发」。
 *
 * `compat` 逐键浅合并（模型级赢）：provider 级作默认，模型级只盖住自己写了的键。
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
    ...(declared?.cost === undefined ? {} : { cost: declared.cost }),
    ...(declared?.reasoning === undefined ? {} : { reasoning: declared.reasoning }),
    ...(declared?.input === undefined ? {} : { input: declared.input }),
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

