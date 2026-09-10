import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function isGitRoot(dir: string): boolean {
  return existsSync(resolve(dir, '.git'));
}

/** 有 git 用仓库根，否则用启动 cwd，避免把整个 IdeaProjects 当成一个项目。 */
export function resolveWorkspaceRoot(startDir: string): string {
  let current = resolve(startDir);
  for (;;) {
    if (isGitRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(startDir);
    current = parent;
  }
}
