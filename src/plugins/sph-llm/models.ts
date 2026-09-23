import type { ApiProtocol } from '../../config/primitives.js';
import { isRecord } from '../../util.js';

/**
 * 把模型 ID 收成列表左侧的可读名。
 *
 * OpenAI 兼容的 `/models` 有效字段几乎只有 `id`：
 * `owned_by` 是网关名、`created` 是请求时刻，都不能拿来填弹窗。
 * 连字符版本号（`4-8`）收成 `4.8`，其余按词 Title Case，避免右侧空一长条。
 *
 * 现在只作为 models.json 里未声明 `name` 的模型的展示兜底：声明了 name 就直接用。
 */
export function displayNameForModel(id: string): string {
  const words: string[] = [];
  for (const part of id.split('-')) {
    if (part === '') continue;
    if (/^\d+(\.\d+)*$/.test(part)) {
      const prev = words[words.length - 1];
      if (prev !== undefined && /^\d+(\.\d+)*$/.test(prev)) {
        words[words.length - 1] = `${prev}.${part}`;
        continue;
      }
      words.push(part);
      continue;
    }
    if (part === 'gpt' || part === 'glm') {
      words.push(part.toUpperCase());
      continue;
    }
    words.push(part.charAt(0).toUpperCase() + part.slice(1));
  }
  return words.length > 0 ? words.join(' ') : id;
}

/**
 * 从当前上游读取模型目录。
 *
 * 为什么单独放在 LLM 层：模型目录请求与具体对话协议无关，TUI 只需要拿到可选项，
 * 这样 API Key 不会进入界面状态，也不会在界面错误信息里被意外回显。
 *
 * 只被 `/provider` 向导调用（按需发现，结果由用户选中后落为 models.json 的声明）——
 * 不是常驻缓存：声明始终是唯一事实源，拉一次存住只会静默给出旧列表。
 */
/**
 * 从目录 JSON 里取出模型 id。
 *
 * OpenAI / Anthropic / 兼容网关是 `{ data: [{ id }] }`。
 * Gemini 原生是 `{ models: [{ name: "models/gemini-2.5-pro" }] }`，前缀 `models/` 要剥掉。
 * 不维护模型名单：上游没返回的 id 这里也不会出现。
 */
export function modelIdsFromCatalog(payload: unknown): string[] {
  const rows = catalogRows(payload);
  const ids = rows
    .map(catalogId)
    .filter((id): id is string => id !== undefined && id !== '');
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
}

function catalogRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.models)) return payload.models;
  return [];
}

function catalogId(row: unknown): string | undefined {
  if (typeof row === 'string') return row.trim();
  if (!isRecord(row)) return undefined;
  const raw = typeof row.id === 'string' ? row.id : typeof row.name === 'string' ? row.name : undefined;
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.startsWith('models/') ? trimmed.slice('models/'.length) : trimmed;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

export async function listAvailableModels(
  baseUrl: string,
  apiKey: string,
  options?: { signal?: AbortSignal; headers?: Record<string, string>; api?: ApiProtocol },
): Promise<string[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options?.api === 'anthropic-messages') headers['anthropic-version'] = '2023-06-01';
  Object.assign(headers, options?.headers);
  // 鉴权跟协议走。models.json 已经写了同名头就不再盖。
  if (apiKey && options?.api === 'anthropic-messages') {
    if (!hasHeader(headers, 'x-api-key') && !hasHeader(headers, 'authorization')) headers['x-api-key'] = apiKey;
  } else if (apiKey && !hasHeader(headers, 'authorization')) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  const response = await fetch(url, {
    method: 'GET',
    headers,
    signal: options?.signal,
  });
  if (!response.ok) throw new Error(`获取上游模型失败（HTTP ${response.status}）`);

  const payload: unknown = JSON.parse(await response.text());
  const models = modelIdsFromCatalog(payload);
  if (models.length === 0) throw new Error('上游未返回可用模型');
  return models;
}
