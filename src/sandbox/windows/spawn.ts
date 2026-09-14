import { existsSync } from 'node:fs';
import { delimiter, isAbsolute } from 'node:path';
import {
  api,
  HANDLE_FLAG_INHERIT,
  PROCESS_INFORMATION,
  emptyStartup,
  inheritSa,
  lastError,
  type Handle,
} from './win32.js';
import koffi from 'koffi';

export interface Spawned {
  process: Handle;
  thread: Handle;
  stdout: Handle;
  stderr: Handle;
}

function quote(arg: string): string {
  if (!/[ \t"]/u.test(arg)) return arg;
  return `"${arg.replaceAll('"', '\\"')}"`;
}

function resolveExecutable(command: string): string {
  if (isAbsolute(command) && existsSync(command)) return command;
  const path = process.env.PATH ?? '';
  const exts = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';');
  const names = command.toLowerCase().endsWith('.exe') ? [command] : [command, ...exts.map((ext) => `${command}${ext}`)];
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = `${dir}\\${name}`;
      if (existsSync(candidate)) return candidate;
    }
  }
  return command;
}

export function spawnAsUser(token: Handle, command: string, args: string[], cwd: string): Spawned {
  const sa = inheritSa();
  const outRead: [Handle] = [null];
  const outWrite: [Handle] = [null];
  const errRead: [Handle] = [null];
  const errWrite: [Handle] = [null];
  if (api.createPipe(outRead, outWrite, sa, 0) === 0) throw lastError('CreatePipe', 'stdout');
  if (api.createPipe(errRead, errWrite, sa, 0) === 0) throw lastError('CreatePipe', 'stderr');
  if (!outRead[0] || !outWrite[0] || !errRead[0] || !errWrite[0]) throw lastError('CreatePipe', 'null');
  api.setHandleInformation(outRead[0], HANDLE_FLAG_INHERIT, 0);
  api.setHandleInformation(errRead[0], HANDLE_FLAG_INHERIT, 0);

  const startup = emptyStartup(null, outWrite[0], errWrite[0]);
  const pi = Buffer.alloc(koffi.sizeof(PROCESS_INFORMATION));
  const exe = resolveExecutable(command);
  const cmd = [exe, ...args].map(quote).join(' ');
  const cmdBuf = Buffer.from(`${cmd}\0`, 'utf16le');
  const created = api.createProcessAsUserW(
    token,
    null,
    cmdBuf,
    null,
    null,
    1,
    0,
    null,
    cwd,
    startup,
    pi,
  );
  api.closeHandle(outWrite[0]);
  api.closeHandle(errWrite[0]);
  if (created === 0) throw lastError('CreateProcessAsUserW', cmd);
  const info = koffi.decode(pi, PROCESS_INFORMATION) as { hProcess: Handle; hThread: Handle };
  if (!info.hProcess) throw lastError('CreateProcessAsUserW', 'null process handle');
  return { process: info.hProcess, thread: info.hThread, stdout: outRead[0], stderr: errRead[0] };
}

/**
 * 把管道里当前可读的数据全部追加到 chunks。
 *
 * 必须与等待进程退出交替调用：子进程 stdout 写满管道缓冲区后会阻塞在 write，
 * 若父进程只在 wait 上死等，双方互锁到超时为止（见 backend.run）。
 */
export function drainHandle(handle: Handle, chunks: string[]): void {
  for (;;) {
    const avail: [number] = [0];
    if (api.peekNamedPipe(handle, null, 0, null, avail, null) === 0) break;
    if (avail[0] === 0) break;
    const buf = Buffer.alloc(Math.min(avail[0], 64 * 1024));
    const read: [number] = [0];
    if (api.readFile(handle, buf, buf.length, read, null) === 0) break;
    if (read[0] === 0) break;
    chunks.push(buf.subarray(0, read[0]).toString('utf8'));
  }
}

/** 仅在 WaitForSingleObject 返回 WAIT_OBJECT_0 后调用。 */
export function readExitCode(processHandle: Handle): number {
  const code: [number] = [0];
  if (api.getExitCodeProcess(processHandle, code) === 0) throw lastError('GetExitCodeProcess');
  return code[0];
}
