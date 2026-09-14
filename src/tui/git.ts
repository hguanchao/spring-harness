/**
 * 读取当前目录的 git 分支名，用于底栏展示。
 *
 * 不调用 git 命令：直接读 .git/HEAD（含 worktree 的 .git 文件），避免在每次渲染时
 * fork 子进程。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function resolveGitDir(cwd: string): string | undefined {
  const dotGit = join(cwd, '.git');
  if (!existsSync(dotGit)) return undefined;
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    // worktree / submodule：.git 是文件，内容形如 "gitdir: /path/to/worktree"
    const content = readFileSync(dotGit, 'utf8').trim();
    const match = /^gitdir:\s*(.+)$/m.exec(content);
    return match ? match[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

export function readGitBranch(cwd: string): string | undefined {
  const gitDir = resolveGitDir(cwd);
  if (!gitDir) return undefined;
  try {
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    const match = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (match) return match[1];
    // detached HEAD：展示短 sha。
    return head.slice(0, 7);
  } catch {
    return undefined;
  }
}
