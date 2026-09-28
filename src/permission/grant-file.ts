/**
 * 跨会话的审批授权：`<项目>/.sph/permissions.json`。
 *
 * 存的是「这个动作以后别再问」——**具体动作**（`approvalScopeKey` 的产物），不是工具名。
 * 存工具名会把「批准一条命令 = 放行整个工具」的洞从会话内放大到跨会话，所以文件的每一项
 * 都是一条看得懂的动作。
 *
 * 为什么是项目里的文件而不是 `~/.sph/config.toml [grants]`：授权的作用域本来就是项目
 * （按 git 仓库根划分），放在项目里，作用域由文件位置直接表达，不用再维护一层 scope 键；
 * 换一个仓库也不会把授权带过去。代价是这个文件**会跟着仓库走**，所以写入时顺手把它加进
 * 项目的 `.gitignore`（见 ensureIgnored）——授权是本地决定，不该被 commit。
 *
 * 文件是 sph 自己的，坏了只影响「少记了几条授权」这一件事：解析失败按空集合处理并给出
 * 警告（方向安全——丢授权只会多问一次，不会多放行）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 授权文件里的一项：动作键原文。 */
interface GrantFile {
  version: 1;
  allow: string[];
}

const FILE_NAME = 'permissions.json';

/** `<scopeRoot>/.sph/permissions.json`。 */
export function grantFilePath(scopeRoot: string): string {
  return join(scopeRoot, '.sph', FILE_NAME);
}

export interface ReadGrantsResult {
  keys: string[];
  /** 文件存在但读不回来时的原因；调用方负责让用户看见它。 */
  warning?: string;
}

/** 读一个项目的授权。缺席即空；坏文件按空处理并把原因交回调用方。 */
export function readGrants(scopeRoot: string): ReadGrantsResult {
  const path = grantFilePath(scopeRoot);
  if (!existsSync(path)) return { keys: [] };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { keys: [], warning: `${path}: not a JSON object — treated as no grants` };
    }
    const raw = (parsed as { allow?: unknown }).allow;
    if (raw === undefined) return { keys: [] };
    if (!Array.isArray(raw)) return { keys: [], warning: `${path}: "allow" must be an array — treated as no grants` };
    const keys = raw.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
    return { keys };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { keys: [], warning: `${path}: ${message} — treated as no grants` };
  }
}

/**
 * 追加一条授权。
 *
 * 写前重读：另一个 sph 进程可能刚批准过别的动作，整表覆盖会把那些抹掉（与 `[grants]`
 * 时代同一个理由）。写入走临时文件 + rename，避免中途崩掉留下半截 JSON。
 */
export function addGrant(scopeRoot: string, key: string): void {
  const action = key.trim();
  if (action === '') return;
  const path = grantFilePath(scopeRoot);
  const { keys } = readGrants(scopeRoot);
  if (keys.includes(action)) return;
  const next: GrantFile = { version: 1, allow: [...keys, action] };
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  try {
    renameSync(temp, path);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // 清理失败就算了，别把原始错误盖掉
    }
    throw error;
  }
  ensureIgnored(scopeRoot);
}

/**
 * 确保项目根忽略了授权文件。
 *
 * 授权是「这台机器上这个人批准过什么」，跟着仓库走既没意义也不安全（换个 clone 就继承了
 * 一串批准）。只在 git 仓库里动 `.gitignore`：不在仓库里的话那份文件本来也不会被提交，
 * 没有理由凭空造一个 `.gitignore`。
 */
function ensureIgnored(scopeRoot: string): void {
  if (!existsSync(join(scopeRoot, '.git'))) return;
  const ignorePath = join(scopeRoot, '.gitignore');
  const entry = `.sph/${FILE_NAME}`;
  if (existsSync(ignorePath)) {
    const text = readFileSync(ignorePath, 'utf8');
    // 已经忽略整个 `.sph/` 就不用再写一条。
    const covered = text.split(/\r?\n/).some((line) => {
      const trimmed = line.trim();
      return trimmed === entry || trimmed === '.sph/' || trimmed === '.sph';
    });
    if (covered) return;
    const separator = text.endsWith('\n') ? '' : '\n';
    writeFileSync(ignorePath, `${text}${separator}\n# sph: 本项目的授权记录，不入库\n${entry}\n`, 'utf8');
    return;
  }
  writeFileSync(ignorePath, `# sph: 本项目的授权记录，不入库\n${entry}\n`, 'utf8');
}
