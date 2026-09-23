/**
 * 内置沙箱后端：同机策略，按操作系统选机制。
 *
 * Linux 先 bwrap，探不通再 Landlock。macOS 是 Seatbelt。Windows 是受限令牌 + ACL。
 * 三套都只约束写；读和网络留在宿主。策略（read-only 下拒绝 write/edit）在核心，
 * 这里只回答「怎么关」。`off` 不进这个工厂。
 */
import { sphHome } from '../../home.js';
import { SandboxError, type SandboxHandle, type SandboxMode } from '../../sandbox/types.js';
import { DarwinSeatbeltSandbox } from './darwin.js';
import { LinuxBwrapSandbox, bwrapUsable, findBwrap } from './linux.js';
import { LinuxLandlockSandbox, landlockUsable } from './landlock.js';
import { selectRunner } from './select.js';

type LinuxRunner = 'bwrap' | 'landlock';

let linuxRunner: Promise<LinuxRunner> | undefined;

function chooseLinuxRunner(mode: Exclude<SandboxMode, 'off'>, workspaceRoot: string, tempDir: string): Promise<LinuxRunner> {
  linuxRunner ??= selectRunner<LinuxRunner>([
    { id: 'bwrap', usable: () => bwrapUsable(mode, workspaceRoot, tempDir) },
    { id: 'landlock', usable: () => landlockUsable() },
  ]);
  return linuxRunner;
}

/** confine 档位的后端。`off` 由核心自理，进到这里就是调用方传错了。 */
export async function createSandboxBackend(
  mode: SandboxMode,
  workspaceRoot: string,
  tempDir: string,
  keepWorkspaceGrant?: () => boolean,
): Promise<SandboxHandle> {
  if (mode === 'off') throw new SandboxError('sandbox off has no confined backend');
  if (process.platform === 'win32') {
    const { WindowsAclSandbox } = await import('./windows/backend.js');
    const backend = new WindowsAclSandbox({
      mode,
      workspaceRoot,
      sphHomeDir: sphHome(),
      tempDir,
      keepWorkspaceGrant,
    });
    await backend.init();
    return backend;
  }
  if (process.platform === 'linux') {
    const runner = await chooseLinuxRunner(mode, workspaceRoot, tempDir);
    if (runner === 'bwrap') {
      const bwrap = findBwrap();
      if (!bwrap) throw new SandboxError('bwrap disappeared after probe; pass --sandbox off');
      const backend = new LinuxBwrapSandbox(mode, workspaceRoot, tempDir, bwrap);
      await backend.init();
      return backend;
    }
    const backend = new LinuxLandlockSandbox(mode, workspaceRoot, tempDir);
    await backend.init();
    return backend;
  }
  if (process.platform === 'darwin') {
    const backend = new DarwinSeatbeltSandbox(mode, workspaceRoot, tempDir);
    await backend.init();
    return backend;
  }
  throw new SandboxError(`sandbox ${mode} is unsupported on ${process.platform}; pass --sandbox off`);
}
