/**
 * 跨会话的审批授权：按**项目**作用域记下「这个动作以后别再问」。
 *
 * 作用域键取 git 仓库根，不在仓库里就退回工作区根。为什么不按精确 cwd：在仓库里任何
 * 位置批准的动作都应该对整个仓库有效，按 cwd 分键会让子目录里启动的会话看不到仓库根上
 * 批准过的授权。按项目记，换一个仓库不会把授权带过去。
 *
 * 落在 `<项目>/.sph/permissions.json`（见 grant-file.ts）。**不再是** config.toml 的
 * `[grants]`：授权本来就是项目内的一次性决定，文件位置本身就是作用域，不必再维护一层
 * scope 键，也不会和「人写的意图」挤在同一份文件里。
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { canonicalize, casefoldPath } from '../workspace/boundary.js';
import { addGrant, grantFilePath, readGrants } from './grant-file.js';

/**
 * 从工作区根向上找第一个含 `.git` 的目录。
 *
 * 不 fork `git rev-parse`：sph 读分支时也是直接读 `.git/HEAD`
 * （见 src/plugins/sph-tui/footer/git.ts），这里保持同一条线——不为一次路径解析起子进程。
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

/** 授权读写口。TUI 按当前工作区建一个；测试注入临时目录即可。 */
export interface GrantStore {
  /** 解析后的作用域根，供界面展示。 */
  readonly scope: string;
  /** 授权文件路径，供界面展示「写进哪儿」。 */
  readonly path: string;
  load(): readonly string[];
  add(key: string): void;
  /** 文件存在但读不回来时的原因；没有就是 undefined。 */
  warning(): string | undefined;
}

export function createGrantStore(workspaceRoot: string): GrantStore {
  const scope = permissionScopeRoot(workspaceRoot);
  const path = grantFilePath(scope);
  let lastWarning: string | undefined;
  return {
    scope,
    path,
    load() {
      const result = readGrants(scope);
      lastWarning = result.warning;
      return result.keys;
    },
    add(key: string) {
      // addGrant 内部写前重读：授权可能已被另一个 sph 进程批准过，整表覆盖会把那些抹掉。
      addGrant(scope, key);
    },
    warning() {
      return lastWarning;
    },
  };
}
