/**
 * 跨会话的审批授权：按**项目**作用域记下「这个动作以后别再问」。
 *
 * 作用域键取 git 仓库根，不在仓库里就退回工作区根。为什么不按精确 cwd：在仓库里任何
 * 位置批准的动作都应该对整个仓库有效，按 cwd 分键会让子目录里启动的会话看不到仓库根上
 * 批准过的授权。按项目记，换一个仓库不会把授权带过去。
 *
 * 存储在 config.toml 的 `[grants]` 表（键是作用域根）。不叫 `[permissions]`：那是规则表
 * （allow/ask/deny）的名字，这里存的是已批准的**授权**。存的内容仍是 approvalScopeKey
 * 的产物——**具体动作**而不是工具名，存工具名会把「批准一条命令 = 放行整个工具」这个
 * 洞从会话内放大到跨会话。
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { sphConfigPath } from '../home.js';
import { canonicalize, casefoldPath } from '../workspace/boundary.js';
import { readState, addGrant } from '../config/state.js';

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
 * 发授权——那恰好是最不该被一条命令覆盖的地方。没有 git 根时不落盘。
 */
export function permissionScopeRoot(workspaceRoot: string, home = homedir()): string {
  const canonical = canonicalize(workspaceRoot);
  const root = findGitRoot(canonical) ?? canonical;
  if (casefoldPath(root) === casefoldPath(canonicalize(home))) return canonical;
  return root;
}

/** 授权读写口。TUI 按当前工作区建一个；测试注入临时文件即可。 */
export interface GrantStore {
  /** 解析后的作用域根，供界面展示。 */
  readonly scope: string;
  load(): readonly string[];
  add(key: string): void;
}

export function createGrantStore(workspaceRoot: string, filePath: string = sphConfigPath()): GrantStore {
  const scope = permissionScopeRoot(workspaceRoot);
  return {
    scope,
    load() {
      return readState(filePath).grants[scope] ?? [];
    },
    add(key: string) {
      // addGrant 内部写前重读：授权可能已被另一个 sph 进程批准过，整表覆盖会把那些抹掉。
      addGrant(scope, key, filePath);
    },
  };
}
