/**
 * `@/*` 的运行期解析钩子。
 *
 * 由 `registerAliasResolver()` 注册，在模块解析线程里执行。它只能靠相对自身的 URL 定位
 * 产物根——本文件固定位于 `dist/cli/`，`../` 正好是 `dist/`，所以 `@/tui/index.js`
 * 映射到 `dist/tui/index.js`。
 *
 * 存在的理由：`tsc` 不改写 import 说明符，`dist/` 里保留的仍是 `@/...` 这种裸标识，
 * 而 Node 会把它当包名去 node_modules 找。这一步就是把标识接回包内文件。
 *
 * 先交给默认解析、失败才兜底，而不是一见到 `@/` 就改写：钩子是进程级的，嵌入方（见
 * `src/sdk.ts`）可能自己也用 `@/` 指它自己的源码，抢在前面会把它的解析劫持到我们的产物树。
 */

import type { ResolveHook } from 'node:module';

export const resolve: ResolveHook = async (specifier, context, nextResolve) => {
  if (!specifier.startsWith('@/')) return nextResolve(specifier, context);
  try {
    return await nextResolve(specifier, context);
  } catch {
    return nextResolve(new URL(`../${specifier.slice(2)}`, import.meta.url).href, context);
  }
};
