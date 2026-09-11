import { homedir } from 'node:os';
import { join } from 'node:path';

/** 用户级状态集中在 ~/.sph，避免污染工作区。 */
export function sphHome(): string {
  return join(homedir(), '.sph');
}

export function sphConfigPath(): string {
  return join(sphHome(), 'config.toml');
}

export function sphSessionsRoot(): string {
  return join(sphHome(), 'sessions');
}

/** 已信任工作区清单；与 config/sessions 一样放用户主目录，不进仓库。 */
export function sphTrustedPath(): string {
  return join(sphHome(), 'trusted.json');
}

/** 上游模型目录缓存（按 base URL 分桶）。纯缓存，删掉只会让下次 /model 慢一拍。 */
export function sphModelsPath(): string {
  return join(sphHome(), 'models.json');
}

/** 超长工具结果的落盘根目录（按会话再分一层）。删掉只会让模型读不回旧结果。 */
export function sphSpillRoot(): string {
  return join(sphHome(), 'spill');
}
