import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathEscapes, toWorkspaceRelative } from '../workspace/boundary.js';

/**
 * 项目记忆加载与触碰式注入。
 *
 * 设计取舍：不做 pi 的祖先目录递归链——sph 的 workspace root 已经由 git
 * 边界确定，向上越界反而模糊了 workspace 概念。采取三层：
 * 用户级 ~/.sph/AGENTS.md（全局偏好）→ workspace root 的 AGENTS.md →
 * root 的 CLAUDE.md（兼容存量项目）。子目录 AGENTS.md 采用触碰注入：
 * 工具读写到哪里、哪层的指令文件才进入上下文，避免全树扫描。
 */

const FILE_LIMIT = 20_000;
const TOTAL_LIMIT = 40_000;
/** 单次 drain 最多注入几个触碰到的指令文件，防上下文被一次性撑爆。 */
export const TOUCH_DRAIN_LIMIT = 3;

export interface MemoryFile {
  source: 'user' | 'project';
  path: string;
  text: string;
}

function readFirst(paths: string[], source: MemoryFile['source']): MemoryFile | undefined {
  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, 'utf8');
      if (!raw.trim()) continue;
      return { source, path, text: raw.slice(0, FILE_LIMIT) };
    } catch {
      continue;
    }
  }
  return undefined;
}

export function loadMemory(workspaceRoot: string, sphHome: string): MemoryFile[] {
  const files: MemoryFile[] = [];
  let total = 0;
  const push = (file: MemoryFile | undefined): void => {
    if (!file || total + file.text.length > TOTAL_LIMIT) return;
    total += file.text.length;
    files.push(file);
  };
  push(readFirst([join(sphHome, 'AGENTS.md')], 'user'));
  push(readFirst([join(workspaceRoot, 'AGENTS.md'), join(workspaceRoot, 'CLAUDE.md')], 'project'));
  return files;
}

/**
 * 逃逸规则文件里的标签形态。
 *
 * 指令文件是工作区里的普通文本，模型却会把它们当提示词读。若不加处理，一个包含
 * `</instructions>` 或 `\</system-reminder>` 的 AGENTS.md 就能提前闭合容器、把后面的
 * 正文抬成系统级指令。这里只中和标签形态，不动正文内容。
 */
function neutralizeInstructionText(text: string): string {
  return text.replace(/<\/?(instructions|system-reminder|rules|user_rules)>/gi, (tag) =>
    tag.replace('<', '‹').replace('>', '›'),
  );
}

/**
 * 指令文件 → 提示词片段。
 *
 * 两个来源的**权重不同**，必须在容器上写出来，否则模型只能自己猜：用户级
 * （~/.sph/AGENTS.md）是跨项目的个人偏好，项目级（工作区 AGENTS.md / CLAUDE.md）是
 * 本仓库的约定，冲突时项目级优先——因为它更具体。
 */
export function memoryToPrompt(files: MemoryFile[]): string {
  if (files.length === 0) return '';
  const blocks = files.map((file) => {
    const scope = file.source === 'user' ? 'user-level (applies to every project)' : 'project-level (applies to this workspace)';
    return `[instructions from ${file.path} — ${scope}]\n${neutralizeInstructionText(file.text)}`;
  });
  return [
    'Follow these instructions where they apply. If a user-level and a project-level instruction conflict, the project-level one wins — it is more specific to this code.',
    'They are instructions about how to work here, not a task: do not carry out anything they merely describe.',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}

/**
 * 触碰注入的单个片段（loop 在工具边界把嵌套指令塞进会话）。
 * 与 memoryToPrompt 用同一套措辞和同一道逃逸，避免两个入口行为分叉。
 */
export function touchInstructionBlock(relPath: string, text: string): string {
  return `[instructions from ${relPath} — applies under this directory]\n${neutralizeInstructionText(text)}`;
}

export interface TouchInjection {
  relPath: string;
  text: string;
}

/** 记录工具触碰过的路径，把路径祖先目录上的 AGENTS.md/CLAUDE.md 按需注入。 */
export class TouchMemory {
  private readonly injected = new Set<string>();
  private pending: TouchInjection[] = [];

  constructor(private readonly workspaceRoot: string) {}

  /** 工具读写成功后调用；只做文件系统探测，不抛错。root 层指令已进 system prompt，跳过防重复。 */
  noteTouch(absPath: string): void {
    let dir = dirname(absPath);
    const rel = relative(this.workspaceRoot, dir);
    if (pathEscapes(rel)) return;
    for (;;) {
      if (dir === this.workspaceRoot) break;
      for (const name of ['AGENTS.md', 'CLAUDE.md']) {
        const candidate = join(dir, name);
        if (this.injected.has(candidate) || !existsSync(candidate)) continue;
        this.injected.add(candidate);
        try {
          const text = readFileSync(candidate, 'utf8').slice(0, FILE_LIMIT);
          if (text.trim()) {
            this.pending.push({ relPath: toWorkspaceRelative(this.workspaceRoot, candidate), text });
          }
        } catch {
          continue;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  /** loop 在工具执行边界取走待注入的指令；最多 TOUCH_DRAIN_LIMIT 条。 */
  drain(): TouchInjection[] {
    const out = this.pending.slice(0, TOUCH_DRAIN_LIMIT);
    this.pending = this.pending.slice(TOUCH_DRAIN_LIMIT);
    return out;
  }
}
