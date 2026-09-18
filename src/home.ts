import { homedir } from 'node:os';
import { join } from 'node:path';

/** 用户级状态集中在 ~/.sph，避免污染工作区。 */
export function sphHome(): string {
  return join(homedir(), '.sph');
}

function underHome(...parts: string[]): string {
  return join(sphHome(), ...parts);
}

export function sphConfigPath(): string {
  return underHome('config.toml');
}

export function sphSessionsRoot(): string {
  return underHome('sessions');
}

/**
 * 端点与模型的声明注册表。
 *
 * 全部由人写：provider 的 baseUrl / apiKey / headers 与每个模型的 id / contextWindow /
 * maxTokens 都在这里声明，`config.toml` 用 `provider` + `model` 两个指针选择。不再做
 * 上游 /models 拉取缓存——上游会新增模型，但缓存永不刷新只会静默地给出旧列表；既然
 * 目录靠人维护，就让唯一来源也是人。
 */
export function sphModelsPath(): string {
  return underHome('models.json');
}

/** 超长工具结果的落盘根目录（按会话再分一层）。删掉只会让模型读不回旧结果。 */
export function sphSpillRoot(): string {
  return underHome('spill');
}

/** 用户主题：`{ "primary": "#9d7cd8", ... }` 覆盖 PALETTE 里同名键。 */
export function sphThemePath(): string {
  return underHome('theme.json');
}
