/**
 * 内置沙箱后端：按操作系统选机制。
 *
 * Windows 是受限令牌 + ACL，Linux 是 bwrap。策略（read-only 下拒绝 write/edit）
 * 不在这里——那是核心每次写工具都要问的事，缺席不能放开。本文件只回答「怎么关」。
 */
import { sphHome } from '../../home.js';
import { SandboxError, type SandboxHandle, type SandboxMode } from '../../sandbox/types.js';

/** confine 档位的后端。`off` 由核心自理，进到这里就是调用方传错了。 */
export async function createSandboxBackend(
  mode: SandboxMode,
  workspaceRoot: string,
  tempDir: string,
): Promise<SandboxHandle> {
  if (mode === 'off') throw new SandboxError('sandbox off has no confined backend');
  if (process.platform === 'win32') {
    const { WindowsAclSandbox } = await import('./windows/backend.js');
    const backend = new WindowsAclSandbox({
      mode,
      workspaceRoot,
      sphHomeDir: sphHome(),
      tempDir,
    });
    await backend.init();
    return backend;
  }
  if (process.platform === 'linux') {
    const { LinuxBwrapSandbox } = await import('./linux.js');
    const backend = new LinuxBwrapSandbox(mode, workspaceRoot, sphHome(), tempDir);
    await backend.init();
    return backend;
  }
  throw new SandboxError(
    `sandbox ${mode} is unsupported on ${process.platform}; pass --sandbox off`,
  );
}
