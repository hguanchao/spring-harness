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

/** 已信任工作区清单；与 config/sessions 一样放用户主目录，不进仓库。 */
export function sphTrustedPath(): string {
  return underHome('trusted.json');
}

/**
 * 跨会话的审批授权清单，按项目作用域分桶。
 *
 * 放用户主目录而不是工作区里：Claude Code 把「以后别再问」写进项目内的
 * `.claude/settings.local.json`，那是它的选择；sph 的约定是用户级状态一律不落仓库，
 * 免得一个跑过 agent 的项目凭空多出没被 .gitignore 覆盖的文件。
 */
export function sphPermissionsPath(): string {
  return underHome('permissions.json');
}

/** 上游模型目录缓存（按 base URL 分桶）。纯缓存，删掉只会让下次 /model 慢一拍。 */
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
