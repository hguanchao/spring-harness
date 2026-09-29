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
 * 本包产物里的 `@/` 直接改写，不再先走默认解析再失败兜底：启动路径上有近百个
 * `@/` 说明符，每次失败重试都会多一轮 node_modules 查找。嵌入方自己的 `@/`
 * （见 `src/sdk.ts`）parentURL 不在本包 `dist/` 下，仍走默认解析。
 */

import type { ResolveHook } from 'node:module';
import { fileURLToPath } from 'node:url';

const distRoot = new URL('../', import.meta.url);
const distRootPath = fileURLToPath(distRoot);

function isInsideDist(parentURL: string | undefined): boolean {
  if (parentURL === undefined) return false;
  try {
    const parent = fileURLToPath(parentURL);
    return parent.startsWith(distRootPath);
  } catch {
    return false;
  }
}

export const resolve: ResolveHook = async (specifier, context, nextResolve) => {
  if (!specifier.startsWith('@/')) return nextResolve(specifier, context);
  if (isInsideDist(context.parentURL)) {
    return nextResolve(new URL(specifier.slice(2), distRoot).href, context);
  }
  try {
    return await nextResolve(specifier, context);
  } catch {
    return nextResolve(new URL(specifier.slice(2), distRoot).href, context);
  }
};
