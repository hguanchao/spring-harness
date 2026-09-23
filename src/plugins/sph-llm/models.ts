import { isRecord } from '../../util.js';

/**
 * 把模型 ID 收成列表左侧的可读名。
 *
 * OpenAI 兼容的 `/models`（含 OpenCode zen）有效字段几乎只有 `id`：
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
export async function listAvailableModels(
  baseUrl: string,
  apiKey: string,
  options?: { signal?: AbortSignal; headers?: Record<string, string> },
): Promise<string[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  const headers: Record<string, string> = {
    accept: 'application/json',
    'anthropic-version': '2023-06-01',
    ...options?.headers,
  };
  // 与 createSseClient 同一套免鉴权约定：空 key 不发 Authorization / x-api-key。
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
    headers['x-api-key'] = apiKey;
  }
  const response = await fetch(url, {
    method: 'GET',
    headers,
    signal: options?.signal,
  });
  if (!response.ok) throw new Error(`获取上游模型失败（HTTP ${response.status}）`);

  const payload: unknown = JSON.parse(await response.text());
  const rows = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.data)
      ? payload.data
      : [];
  const ids = rows
    .map((row) => (typeof row === 'string' ? row : isRecord(row) && typeof row.id === 'string' ? row.id : undefined))
    .filter((id): id is string => id !== undefined && id.trim() !== '')
    .map((id) => id.trim());
  const models = [...new Set(ids)].sort((left, right) => left.localeCompare(right));
  if (models.length === 0) throw new Error('上游未返回可用模型');
  return models;
}
