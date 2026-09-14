import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface WorktreeInfo {
  path: string;
  branch: string;
  workspaceRoot: string;
}

/**
 * 子代理 git worktree 隔离（grok-build 的 isolation: worktree 同语义）。
 *
 * 工作树建在 workspace root 内部的 .sph/worktrees/ 下：Windows ACL 沙箱的写授权与
 * Linux bwrap 的 bind 都按 workspace root 授予，树放在 workspace 外面子代理写不进。
 * .sph/ 追加进 .git/info/exclude（仓库本地排除，不动用户的 .gitignore）。
 *
 * 解析失败（非 git 仓库 / git 不可用 / worktree add 失败）即 spawn 失败——grok 同语义，
 * 不静默降级成共享工作区。
 */
export class WorktreeStore {
  private readonly created: WorktreeInfo[] = [];

  create(workspaceRoot: string, id: string): WorktreeInfo {
    const path = join(workspaceRoot, '.sph', 'worktrees', id);
    const branch = `sph/${id}`;
    try {
      execFileSync('git', ['worktree', 'add', '-b', branch, path, 'HEAD'], {
        cwd: workspaceRoot,
        stdio: 'pipe',
        windowsHide: true,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`worktree isolation failed: ${detail.split('\n')[0]}`);
    }
    this.excludeDotSph(workspaceRoot);
    const info: WorktreeInfo = { path, branch, workspaceRoot };
    this.created.push(info);
    return info;
  }

  /** 把 .sph/ 加进 .git/info/exclude：仓库本地排除，幂等，不碰用户的 .gitignore。 */
  private excludeDotSph(workspaceRoot: string): void {
    try {
      const excludePath = join(workspaceRoot, '.git', 'info', 'exclude');
      const current = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
      if (current.split('\n').some((line) => line.trim() === '.sph/')) return;
      const separator = current === '' || current.endsWith('\n') ? '' : '\n';
      appendFileSync(excludePath, `${separator}.sph/\n`, 'utf8');
    } catch {
      // 排除失败只影响 parent status 的干净度，不阻塞隔离本身
    }
  }

  list(): WorktreeInfo[] {
    return [...this.created];
  }

  /**
   * 进程退出路径：干净的（无任何改动，含未跟踪文件）工作树移除——提交已留在
   * sph/<id> 分支上；有未提交改动的一律保留目录，路径由调用方报告，绝不静默
   * 丢弃子代理的工作。
   */
  dispose(): { kept: string[] } {
    const kept: string[] = [];
    for (const info of this.created) {
      try {
        const status = execFileSync('git', ['status', '--porcelain'], {
          cwd: info.path,
          stdio: 'pipe',
          windowsHide: true,
        }).toString();
        if (status.trim() === '') {
          execFileSync('git', ['worktree', 'remove', info.path], {
            cwd: info.workspaceRoot,
            stdio: 'pipe',
            windowsHide: true,
          });
        } else {
          kept.push(info.path);
        }
      } catch {
        kept.push(info.path);
      }
    }
    this.created.length = 0;
    return { kept };
  }
}
