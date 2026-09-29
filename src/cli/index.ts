#!/usr/bin/env node
/**
 * 进程入口。
 *
 * 只做两件事：挂上 `@/*` 的运行期解析器，再把 CLI 主体加载进来。
 * 主体必须走动态 import —— 静态 import 会在本文件求值之前就解析整个依赖图，
 * 钩子赶不上，`dist/` 里的 `@/...` 会直接报找不到模块。
 */

import './alias-resolver.js';

await import('./main.js');
