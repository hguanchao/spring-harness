/**
 * Landlock 启动器。由 sph 在 Linux 上拉起，给自己套上规则后再执行真正的命令。
 *
 * 必须是子进程：restrict_self 会连同调用者一起困住，套在 sph 主进程上就把代理自己关死了。
 * 本文件不 import 仓库里的其它模块，plain node 能直接跑源码或编译产物。
 */

import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import koffi from 'koffi';

const CREATE = 444;
const ADD = 445;
const RESTRICT = 446;
const VERSION_FLAG = 1;
const PATH_BENEATH = 1;
/** Linux O_PATH。只拿一个路径句柄给 Landlock，不去读目录内容。 */
const O_PATH = 0o10000000;

interface Grants {
  readOnly: string[];
  readWrite: string[];
}

function fsMask(abi: number): bigint {
  const bits = abi >= 5 ? 16 : abi >= 3 ? 15 : abi >= 2 ? 14 : abi >= 1 ? 13 : 0;
  return bits === 0 ? 0n : (1n << BigInt(bits)) - 1n;
}

const READ = (1n << 0n) | (1n << 2n) | (1n << 3n);

function apply(grants: Grants): void {
  const libc = koffi.load('libc.so.6');
  const syscall = libc.func('int64 syscall(int64, int64, int64, int64, int64, int64)') as (
    n: number,
    a: number | bigint,
    b: number | bigint,
    c: number | bigint,
    d: number | bigint,
    e: number | bigint,
  ) => bigint | number;
  const abi = Number(syscall(CREATE, 0, 0, VERSION_FLAG, 0, 0));
  if (abi <= 0) throw new Error(`landlock ABI unavailable (${abi})`);
  const handled = fsMask(abi);
  const attr = Buffer.alloc(8);
  attr.writeBigUInt64LE(handled);
  const ruleset = Number(syscall(CREATE, koffi.address(attr), 8, 0, 0, 0));
  if (ruleset < 0) throw new Error(`landlock_create_ruleset failed (${ruleset})`);
  const allow = (path: string, access: bigint) => {
    const fd = openSync(path, O_PATH);
    try {
      const rule = Buffer.alloc(12);
      rule.writeBigUInt64LE(access & handled, 0);
      rule.writeInt32LE(fd, 8);
      const added = Number(syscall(ADD, ruleset, PATH_BENEATH, koffi.address(rule), 0, 0));
      if (added !== 0) throw new Error(`landlock_add_rule ${path} failed (${added})`);
    } finally {
      closeSync(fd);
    }
  };
  for (const path of grants.readOnly) allow(path, READ);
  for (const path of grants.readWrite) allow(path, handled);
  const restricted = Number(syscall(RESTRICT, ruleset, 0, 0, 0, 0));
  closeSync(ruleset);
  if (restricted !== 0) throw new Error(`landlock_restrict_self failed (${restricted})`);
}

function main(): void {
  // argv: [node, entry, grants-json, command, ...args]
  const grants = JSON.parse(process.argv[2] ?? '') as Grants;
  const command = process.argv[3];
  if (!command) throw new Error('landlock entry missing command');
  apply(grants);
  const child = spawn(command, process.argv.slice(4), { stdio: 'inherit' });
  child.on('error', (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(127);
  });
  child.on('close', (code) => process.exit(code ?? 1));
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(126);
}
