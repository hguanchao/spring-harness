/**
 * 跨会话的审批授权：按**项目**作用域记下「这个动作以后别再问」。
 *
 * 作用域键取 git 仓库根，不在仓库里就退回工作区根。为什么不按精确 cwd：在仓库里任何
 * 位置批准的动作都应该对整个仓库有效，按 cwd 分键会让子目录里启动的会话看不到仓库根上
 * 批准过的授权。grok-build 与 Claude Code 都选了按项目，理由相同。
 *
 * 位置照 sph 的既有约定放 `~/.sph`，**不写进仓库**（理由见 home.ts）。
 *
 * 存的是 `approvalScopeKey` 的产物，也就是**具体动作**而不是工具名——存工具名会把
 * 「批准一条命令 = 放行整个工具」这个洞从会话内放大到跨会话。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { sphPermissionsPath } from '../home.js';
import { canonicalize, casefoldPath } from '../workspace/boundary.js';

/** 一个作用域下的授权清单；键是规范化的作用域根。 */
interface PermissionsFile {
  scopes: Record<string, string[]>;
}

/**
 * 从工作区根向上找第一个含 `.git` 的目录。
 *
 * 不 fork `git rev-parse`：sph 读分支时也是直接读 `.git/HEAD`（见 tui/git.ts），
 * 这里保持同一条线——不为一次路径解析起子进程。
 */
function findGitRoot(from: string): string | undefined {
  let dir = canonicalize(from);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * 授权存储的作用域根。
 *
 * `$HOME` 上的仓库退回工作区根：dotfiles 风格的仓库如果按仓库根分键，等于给整个家目录
 * 发授权——那恰好是最不该被一条命令覆盖的地方。grok-build 对同一种情况做了同样的例外。
 */
export function permissionScopeRoot(workspaceRoot: string, home = homedir()): string {
  const canonical = canonicalize(workspaceRoot);
  const root = findGitRoot(canonical) ?? canonical;
  if (casefoldPath(root) === casefoldPath(canonicalize(home))) return canonical;
  return root;
}

function readScopes(filePath: string): Record<string, string[]> {
  if (!existsSync(filePath)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const scopes = (parsed as PermissionsFile).scopes;
    if (!scopes || typeof scopes !== 'object' || Array.isArray(scopes)) return {};
    const out: Record<string, string[]> = {};
    for (const [scope, grants] of Object.entries(scopes)) {
      if (!Array.isArray(grants)) continue;
      const clean = grants.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
      if (clean.length > 0) out[scope] = clean;
    }
    return out;
  } catch {
    // 坏文件当「没有任何授权」：读不回来只会多问几次，绝不会静默放行。
    return {};
  }
}

function writeScopes(filePath: string, scopes: Record<string, string[]>): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify({ scopes } satisfies PermissionsFile, null, 2)}\n`, 'utf8');
}

/** 授权读写口。TUI 按当前工作区建一个；测试注入临时文件即可。 */
export interface GrantStore {
  /** 解析后的作用域根，供界面展示。 */
  readonly scope: string;
  load(): readonly string[];
  add(key: string): void;
}

export function createGrantStore(workspaceRoot: string, filePath = sphPermissionsPath()): GrantStore {
  const scope = permissionScopeRoot(workspaceRoot);
  return {
    scope,
    load() {
      return readScopes(filePath)[scope] ?? [];
    },
    add(key: string) {
      // 写前重读：授权可能已被另一个 sph 进程或用户手工加过，整文件覆盖会把那些抹掉。
      const scopes = readScopes(filePath);
      const current = scopes[scope] ?? [];
      if (current.includes(key)) return;
      writeScopes(filePath, { ...scopes, [scope]: [...current, key] });
    },
  };
}
