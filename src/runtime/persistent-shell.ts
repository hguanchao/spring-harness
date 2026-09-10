import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { SandboxHandle } from '../sandbox/open.js';
import { resolveShellBinary } from '../sandbox/shell-bin.js';

const END = '__SPH_SH_END__';

/**
 * 沙箱开启时不能在围栏外养长驻进程。
 * confined：每次仍走 sandbox.run（有 cwd/env 连续性就靠调用方自己写文件）。
 * off：同一 pwsh/sh 进程复用 stdin。
 */
export class PersistentShell {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = '';
  private waiter: ((chunk: string) => void) | undefined;
  /** 在途 exec 的 reject 入口：进程消失或 dispose 时用它立刻失败，而不是等满 timeout。 */
  private pendingReject: ((error: Error) => void) | undefined;

  constructor(
    private readonly sandbox: SandboxHandle,
    private readonly cwd: string,
  ) {}

  get confined(): boolean {
    return this.sandbox.status.mode !== 'off';
  }

  async exec(command: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    if (this.confined) {
      const shell = resolveShellBinary();
      return this.sandbox.run({
        command: shell.command,
        args: [...shell.prefixArgs, command],
        cwd: this.cwd,
        timeoutMs,
      });
    }
    const child = this.ensure();
    const script = process.platform === 'win32'
      ? `${command}\nWrite-Output '${END}' $LASTEXITCODE\n`
      : `${command}\necho ${END} $?\n`;
    const collected = this.readUntil(END, timeoutMs);
    child.stdin.write(script);
    const raw = await collected;
    const idx = raw.lastIndexOf(END);
    const body = idx >= 0 ? raw.slice(0, idx).trimEnd() : raw.trimEnd();
    const code = Number(raw.slice(Math.max(idx, 0) + END.length).trim().split(/\s+/).at(-1));
    return { stdout: body, stderr: '', exitCode: Number.isFinite(code) ? code : null };
  }

  dispose(): void {
    this.failPending('persistent shell disposed');
    this.child?.kill();
    this.child = undefined;
  }

  /** 清空等待状态并拒绝在途 exec；重复调用安全。 */
  private failPending(message: string): void {
    const reject = this.pendingReject;
    this.waiter = undefined;
    this.pendingReject = undefined;
    this.buffer = '';
    reject?.(new Error(message));
  }

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) return this.child;
    const shell = resolveShellBinary();
    const args = process.platform === 'win32'
      ? ['-NoProfile', '-NonInteractive']
      : [];
    const child = spawn(shell.command, args, {
      cwd: this.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const onData = (chunk: string) => {
      this.buffer += chunk;
      this.waiter?.(this.buffer);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', () => {
      this.child = undefined;
      // shell 进程已消失，等 END 标记的 exec 永远不会收到数据，直接失败。
      this.failPending('persistent shell exited');
    });
    this.child = child;
    return child;
  }

  private readUntil(marker: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failPending('persistent shell timed out');
        this.child?.kill();
        this.child = undefined;
      }, timeoutMs);
      this.pendingReject = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      const finish = (text: string) => {
        clearTimeout(timer);
        this.waiter = undefined;
        this.pendingReject = undefined;
        this.buffer = '';
        resolve(text);
      };
      this.waiter = (acc) => {
        if (acc.includes(marker)) finish(acc);
      };
      if (this.buffer.includes(marker)) finish(this.buffer);
    });
  }
}
