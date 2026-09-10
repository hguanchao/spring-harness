/**
 * 从当前上游读取模型目录。
 *
 * 为什么单独放在 LLM 层：模型目录请求与具体对话协议无关，TUI 只需要拿到可选项，
 * 这样 API Key 不会进入界面状态，也不会在界面错误信息里被意外回显。
 */
export async function listAvailableModels(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<string[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${apiKey}`,
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    signal,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
