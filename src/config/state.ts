/**
 * `trusted` 清单与 `[grants]` 授权表：写在 config.toml 里的跨会话状态。
 *
 * 为什么搬进来：trusted.json 与 permissions.json 是用户意图（信任哪些工作区、批准过
 * 哪些动作），和 sandbox / approval 一样属于「sph 的安全配置」，散落成两个 JSON 没有
 * 收益。合并后 ~/.sph 下只剩 config.toml（人的一切意图）与 models.json（端点声明）。
 *
 * 与 load.ts 的分工：load 只**读**；这里提供**写**的入口（信任确认、批准动作时的回写）。
 * 读走 loadConfig 的解析；写走 save.ts 的外科手术式替换——config.toml 是手写文件，
 * 注释与键序必须原样保留。
 *
 * 段落名 `[grants]` 而不是 `[permissions]`：后者已被规则表（allow/ask/deny）占用，
 * 这里存的是**已批准的授权**，两个概念不能共用一个名字。
 */

import { existsSync, readFileSync } from 'node:fs';
import { parse as parseToml } from 'smol-toml';
import type { PermissionRules } from '../permission/policy.js';
import { sphConfigPath } from '../home.js';
import { updateConfigFile, updateConfigTableEntry } from './save.js';
import { ConfigError } from './errors.js';

/** 语义校验错误。继承 ConfigError：调用方把它与其它配置错误一视同仁（退出码 2）。 */
export class ConfigStateError extends ConfigError {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigStateError';
  }
}

export interface ConfigState {
  trusted: string[];
  /** 作用域根 → 已批准的动作键（approvalScopeKey 的产物）。 */
  grants: Record<string, string[]>;
  rules: PermissionRules;
}

interface RawState {
  trusted?: unknown;
  grants?: unknown;
  permissions?: unknown;
}

/**
 * 读信任清单与授权表。
 *
 * fail-closed 的边界在哪里：**文件不存在**返回空状态（第一次使用本来就没有）；
 * **文件存在但语法坏掉**由 loadConfig 抛 ConfigError 拒绝启动——语法坏掉时猜语义
 * 必然猜错，宁可让用户修好文件。这里的两个解析函数只处理「语法对、内容类型不对」。
 */
export function readState(path: string = sphConfigPath()): ConfigState {
  if (!existsSync(path)) return { trusted: [], grants: {}, rules: { allow: [], ask: [], deny: [] } };
  const parsed = parseToml(readFileSync(path, 'utf8')) as RawState;
  return {
    trusted: parseTrusted(parsed.trusted),
    grants: parseGrants(parsed.grants),
    rules: parseRules(parsed.permissions),
  };
}

/** 解析顶层 `trusted` 数组；loadConfig 也用它（同一条解析，两处不各写一遍）。 */
export function parseTrusted(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConfigStateError('trusted must be an array of paths');
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new ConfigStateError(`trusted[${index}] must be a non-empty string`);
    }
    return item.trim();
  });
}

/** 解析 `[grants]` 表：作用域根 → 已批准的动作键。 */
export function parseGrants(value: unknown): Record<string, string[]> {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigStateError('grants must be a table of scope → action keys');
  }
  const out: Record<string, string[]> = {};
  for (const [scope, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(raw)) throw new ConfigStateError(`grants."${scope}" must be an array of action keys`);
    const clean = raw.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
    if (clean.length > 0) out[scope] = clean;
  }
  return out;
}

/** `[permissions]` 规则表：三张字符串表，缺省即空。 */
export function parseRules(value: unknown): PermissionRules {
  if (value === undefined) return { allow: [], ask: [], deny: [] };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigStateError('permissions must be a table with allow / ask / deny lists');
  }
  const row = value as Record<string, unknown>;
  // 拼错的键（allows）静默忽略会表现为「规则明明写了却不生效」，所以直接拒绝。
  for (const name of Object.keys(row)) {
    if (name !== 'allow' && name !== 'ask' && name !== 'deny') {
      throw new ConfigStateError(`unknown permissions key: ${name} (allow | ask | deny)`);
    }
  }
  return {
    allow: parseRuleList(row.allow, 'permissions.allow'),
    ask: parseRuleList(row.ask, 'permissions.ask'),
    deny: parseRuleList(row.deny, 'permissions.deny'),
  };
}

function parseRuleList(value: unknown, key: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConfigStateError(`${key} must be an array of rules`);
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new ConfigStateError(`${key}[${index}] must be a non-empty string`);
    }
    return item.trim();
  });
}

/**
 * 记下一条信任（去重）。已被覆盖的不写重复项——祖先信任是否覆盖子孙的判断在调用方
 * （workspace/trust.ts），这里只管「清单里没有就加上」。
 */
export function addTrustedWorkspace(workspaceRoot: string, path: string = sphConfigPath()): void {
  const { trusted } = readState(path);
  if (trusted.includes(workspaceRoot)) return;
  updateConfigFile(path, { trusted: [...trusted, workspaceRoot] });
}

/** 在当前作用域下记一条已批准的动作；重复批准不写重复项。 */
export function addGrant(scope: string, actionKey: string, path: string = sphConfigPath()): void {
  const { grants } = readState(path);
  const current = grants[scope] ?? [];
  if (current.includes(actionKey)) return;
  updateConfigTableEntry(path, 'grants', scope, [...current, actionKey]);
}