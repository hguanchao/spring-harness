/**
 * 读当前 git 分支，只解析 `.git/HEAD`，不起 git 子进程。
 *
 * 状态行会高频重绘（运行中每 120ms 一次），每帧 spawn 一次 git 的代价不可接受；
 * HEAD 就是个几行的文本文件，直接读便宜得多。
 *
 * 覆盖三种形态：
 * - 普通仓库：`.git` 是目录，HEAD 在 `.git/HEAD`；
 * - worktree / submodule：`.git` 是文件，内容为 `gitdir: <path>`；
 * - 分离头指针：HEAD 里直接是对象名，取短哈希。
 * 工作区是仓库子目录时向上查找（带层数上限，避免异常目录结构下无限上溯）。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';

/** 分离头指针时显示的短哈希长度。 */
const SHORT_SHA = 7;
const MAX_UPWARD = 20;

export function readGitBranch(workspaceRoot: string): string | undefined {
  const head = findHeadFile(resolve(workspaceRoot));
  if (!head) return undefined;
  let content: string;
  try {
    content = readFileSync(head, 'utf8').trim();
  } catch {
    return undefined;
  }
  const ref = /^ref:\s*(.+)$/.exec(content);
  if (ref) {
    const name = ref[1].trim().replace(/^refs\/heads\//, '');
    // 非分支引用（如 refs/tags/v1）也照原样显示，比留空有用。
    return name === '' ? undefined : name;
  }
  return content.length >= SHORT_SHA ? content.slice(0, SHORT_SHA) : undefined;
}

function findHeadFile(start: string): string | undefined {
  let current = start;
  for (let depth = 0; depth <= MAX_UPWARD; depth++) {
    const head = headFileAt(current);
    if (head) return head;
    const parent = dirname(current);
    if (parent === current || parent === parse(current).root) return undefined;
    current = parent;
  }
  return undefined;
}

function headFileAt(dir: string): string | undefined {
  const dotGit = join(dir, '.git');
  let stat;
  try {
    stat = statSync(dotGit);
  } catch {
    return undefined;
  }
  if (stat.isDirectory()) {
    const head = join(dotGit, 'HEAD');
    return existsSync(head) ? head : undefined;
  }
  // worktree / submodule：.git 文件内容是 `gitdir: <path>`
  try {
    const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
    if (!match) return undefined;
    const gitDir = match[1].trim();
    const abs = isAbsolute(gitDir) ? gitDir : join(dir, gitDir);
    const head = join(abs, 'HEAD');
    return existsSync(head) ? head : undefined;
  } catch {
    return undefined;
  }
}
