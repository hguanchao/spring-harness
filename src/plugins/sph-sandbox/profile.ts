/**
 * 同机文件策略的参数形状，对齐 dsh sandbox-local 的 profile。
 *
 * 管的是写：read-only 只留 `/dev/null` 这种壳必需的落点；workspace 再加工作区、
 * 私有临时目录，以及 Linux 上的 `/tmp`。读和网络不在这套词汇里，留在宿主上。
 */

export type ConfinedMode = 'workspace' | 'read-only';

export interface LandlockGrants {
  readOnly: readonly string[];
  readWrite: readonly string[];
}

/** workspace 档的可写根。read-only 没有；同一路径只出现一次。 */
export function writableRoots(mode: ConfinedMode, workspaceRoot: string, tempDir: string): string[] {
  if (mode === 'read-only') return [];
  const roots = [workspaceRoot];
  if (tempDir !== workspaceRoot) roots.push(tempDir);
  return roots;
}

/**
 * bwrap：整棵宿主根只读，私有 pid 命名空间里的 `/proc`，避免 procfs 魔术链接绕过挂载。
 * workspace 再叠一层 tmpfs `/tmp` 和工作区 bind。后写的挂载盖住先写的，所以工作区可写。
 */
export function bwrapProfileArgs(mode: ConfinedMode, workspaceRoot: string, tempDir: string): string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent'];
  if (mode !== 'workspace') return args;
  args.push('--tmpfs', '/tmp', '--bind', workspaceRoot, workspaceRoot);
  if (tempDir !== workspaceRoot && tempDir !== '/tmp') args.push('--bind', tempDir, tempDir);
  return args;
}

/** Landlock 允许表：`/` 只读，可写路径是 `/dev/null` 加上该档的可写根。 */
export function landlockGrants(mode: ConfinedMode, workspaceRoot: string, tempDir: string): LandlockGrants {
  const readWrite = ['/dev/null', ...writableRoots(mode, workspaceRoot, tempDir)];
  if (mode === 'workspace' && !readWrite.includes('/tmp')) readWrite.push('/tmp');
  return { readOnly: ['/'], readWrite };
}

function sbplString(path: string): string {
  return `"${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/**
 * Seatbelt 默认允许，再 `deny file-write*`，然后按可写根放行。
 * 路径必须已经是 realpath：Seatbelt 比的是解析后的路径，`/tmp` 在 macOS 上是 `/private/tmp`。
 */
export function seatbeltProfile(mode: ConfinedMode, workspaceRoot: string, tempDir: string): string {
  const forms = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* (literal ${sbplString('/dev/null')}))`,
  ];
  const roots = writableRoots(mode, workspaceRoot, tempDir);
  if (roots.length > 0) {
    forms.push(`(allow file-write* ${roots.map((root) => `(subpath ${sbplString(root)})`).join(' ')})`);
  }
  return forms.join(' ');
}

export function seatbeltArgs(mode: ConfinedMode, workspaceRoot: string, tempDir: string): string[] {
  return ['-p', seatbeltProfile(mode, workspaceRoot, tempDir)];
}
