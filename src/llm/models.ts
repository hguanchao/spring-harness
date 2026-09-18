/**
 * 把模型 ID 收成列表左侧的可读名。
 *
 * OpenAI 兼容的 `/models`（含 OpenCode zen）有效字段几乎只有 `id`：
 * `owned_by` 是网关名、`created` 是请求时刻，都不能拿来填弹窗。
 * 连字符版本号（`4-8`）收成 `4.8`，其余按词 Title Case，避免右侧空一长条。
 *
 * 现在只作为 models.json 里未声明 `name` 的模型的展示兜底：声明了 name 就直接用。
 * 原先的 `listAvailableModels`（上游 /models 拉取）已随模型目录缓存一起删除——
 * 目录改为人在 models.json 里声明，模型清单不再来自网络。
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
