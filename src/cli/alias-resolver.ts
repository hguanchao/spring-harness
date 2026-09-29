/**
 * 把 `@/*` 的运行期解析器挂到 Node 上。
 *
 * `@/*` 只在 tsconfig 的 paths 里声明，那是给编译器和 tsx 看的：`tsc` 不改写 import
 * 说明符，`dist/` 里留下的仍是 `@/tui/index.js`，而 Node 会把它当裸包名去 node_modules
 * 找，直接 ERR_MODULE_NOT_FOUND。这里注册一个 resolve 钩子补上解析这一步。
 *
 * 只有编译产物需要它——tsx 跑源码时自己按 tsconfig 的 paths 解析。两种运行方式的区分
 * 落在入口扩展名上：`.ts` 说明有 TS 加载器在，`.js` 说明跑的是产物。
 *
 * 写成 import 即生效的副作用模块，而不是导出一个注册函数：ESM 按 import 顺序求值，入口
 * 只要把它放在第一行，钩子就赶在其余模块之前挂好；做成函数在入口体内调用已经太晚——
 * 静态 import 早就求值完了。
 */

import { register } from 'node:module';

if (import.meta.url.endsWith('.js')) {
  register(new URL('./alias-hook.js', import.meta.url));
}
