#!/usr/bin/env node
/**
 * 进程入口。
 *
 * 先挂 `@/*` 解析器，再解析参数。`--help` 只吃 args 这一层，不把 bootstrap /
 * undici / 插件图拉进来。真正干活才动态加载 main —— 静态 import 会在本文件
 * 求值之前就解析整个依赖图，钩子赶不上，`dist/` 里的 `@/...` 会找不到模块。
 */

import './alias-resolver.js';
import { HELP, parseArgs } from './args.js';

let args: Awaited<ReturnType<typeof parseArgs>> | undefined;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 2;
}

if (args === undefined) {
  // 用法错误已经记下退出码。
} else if (args.help) {
  process.stdout.write(HELP);
} else {
  const { run } = await import('./main.js');
  await run(args).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
