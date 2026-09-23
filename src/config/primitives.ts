/**
 * `config.toml` 与 `models.json` 共用的解析基元。
 *
 * 抽出来的动因是依赖方向：端点声明搬进 models.json 之后，`registry.ts` 也需要校验
 * `api` 与 `compat`，而这两套校验原本长在 `load.ts` 里。让 registry 去 import load
 * 会和 load → registry 形成环，所以下沉一层。
 */

import { ConfigError } from './errors.js';

/** 会话亲和头形态。`off` 不发；其余按厂商常见名字。 */
export const SESSION_AFFINITY_FORMATS = ['openai', 'openrouter', 'off'] as const;
export type SessionAffinityFormat = (typeof SESSION_AFFINITY_FORMATS)[number];

/**
 * 用户在 `compat` 里声明的覆盖。省略的字段走协议默认，不按主机名推断。
 * 类型留在宿主：配置解析不能依赖 sph-llm 的实现。
 */
export interface CompatProfile {
  promptCacheKey?: boolean;
  promptCacheRetention?: boolean;
  streamOptions?: boolean;
  sessionAffinity?: SessionAffinityFormat;
}

/** 上游 API 协议形态；决定请求端点、鉴权头与消息编码方式。 */
export const API_PROTOCOLS = ['chat-completions', 'responses', 'anthropic-messages'] as const;
export type ApiProtocol = (typeof API_PROTOCOLS)[number];

export function parseApiProtocol(value: unknown, where = 'api'): ApiProtocol {
  if (typeof value !== 'string' || !(API_PROTOCOLS as readonly string[]).includes(value)) {
    throw new ConfigError(`${where} must be one of: ${API_PROTOCOLS.join(' | ')}`);
  }
  return value as ApiProtocol;
}

function parseOptionalBoolean(value: unknown, key: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new ConfigError(`${key} must be a boolean`);
  return value;
}

/** `compat`：省略的字段走协议默认；空表等价于未配置。 */
export function parseCompat(value: unknown, key: string): CompatProfile | undefined {
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
