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
