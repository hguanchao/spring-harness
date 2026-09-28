/**
 * 项目级配置：`<项目>/.sph/config.toml`。
 *
 * 权限只认 `[permissions]`，另外允许 `[mcp_servers]`（项目级 MCP 来源，发现逻辑另读
 * 同一份文件）。其余键一律报错。项目级配置来自仓库——它会随 clone、随 PR 一起流动，
 * 所以它能做的事必须小到可以一眼看完：只能加规则和声明本仓库的 MCP，不能改模型、不能
 * 改审批模式、不能改沙箱档位。出现别的键时报错而不是忽略，才谈得上「一眼看完」。
 *
 * 与用户级的分工（见 permission/policy.ts 的 RuleLayers）：
 *   - deny / ask：任何一层的命中都生效，项目级压得住用户级 allow；
 *   - allow：**未信任的工作区整段丢弃**。信任门管的就是「这个仓库能不能替我放行动作」，
 *     放行类的规则必须过门，收紧类的（deny/ask）不过门也能生效。
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { validateRules, type PermissionRules } from '../permission/policy.js';
import { parseRules } from './state.js';
import { ConfigError } from './errors.js';
import { updateConfigTableEntry } from './save.js';

/** 项目级配置里允许出现的表。`mcp_servers` 是发现逻辑的来源，和规则写在同一份文件里。 */
const PROJECT_TABLES = new Set(['permissions', 'mcp_servers']);

export interface ProjectPermissions {
  path: string;
  /** 路径规则的 `/` 锚定到这里（项目根）。 */
  sourceDir: string;
  /** 生效的规则；未信任时 allow 已被丢弃。 */
  rules: PermissionRules;
  /** 未信任且文件里确实写了 allow —— 界面据此说明「写了却没生效」。 */
  allowDropped: boolean;
}

export function projectConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, '.sph', 'config.toml');
}

/**
 * 读项目级规则。文件不存在返回 undefined（绝大多数项目就是没有）。
 *
 * 语法坏掉、出现不被允许的键都抛 ConfigError：那是仓库发出的、会影响安全边界的声明，
 * 静默忽略会变成「规则明明写了却不生效」。
 */
export function loadProjectPermissions(
  workspaceRoot: string,
  trusted: boolean,
): ProjectPermissions | undefined {
  const path = projectConfigPath(workspaceRoot);
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = parseToml(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ConfigError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`invalid project config (not a table): ${path}`);
  }
  const file = parsed as Record<string, unknown>;
  const unknown = Object.keys(file).filter((key) => !PROJECT_TABLES.has(key));
  if (unknown.length > 0) {
    throw new ConfigError(
      `${path}: a project config may only set [permissions] and [mcp_servers] (found: ${unknown.join(', ')})`,
    );
  }
  const rules = parseRules(file.permissions);
  validateRules(rules, `${path} [permissions]`, (message) => new ConfigError(message));
  return {
    path,
    sourceDir: workspaceRoot,
    rules: trusted ? rules : { allow: [], ask: rules.ask, deny: rules.deny },
    allowDropped: !trusted && rules.allow.length > 0,
  };
}

/**
 * 把一条规则追加进项目级 `[permissions].allow`。
 *
 * 写入走 `save.ts` 的行级手术（与 `config.toml` 同一套）：项目配置是人可能在手改的文件，
 * 注释与键序必须留。写成 `"allow" = [...]`（键带引号）不影响解析，换来的是「只动被改的
 * 那几行」这条保证——为省一对引号手写一份 TOML 序列化并不划算。
 */
export function appendProjectAllowRule(
  workspaceRoot: string,
  rule: string,
): { path: string; added: boolean } {
  const path = projectConfigPath(workspaceRoot);
  mkdirSync(join(workspaceRoot, '.sph'), { recursive: true });
  const current = readProjectAllowRules(path);
  if (current.includes(rule)) return { path, added: false };
  updateConfigTableEntry(path, 'permissions', 'allow', [...current, rule]);
  return { path, added: true };
}

/** 只读项目级 allow 列表。文件坏掉必须抛：当空再写回去会把原来的 deny / ask 整表盖掉。 */
function readProjectAllowRules(path: string): string[] {
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = parseToml(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ConfigError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`invalid project config (not a table): ${path}`);
  }
  return parseRules((parsed as Record<string, unknown>).permissions).allow.slice();
}
