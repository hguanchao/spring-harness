/**
 * 版本号单一来源。
 *
 * 从 package.json 读，而不是在代码里再写一份常量：两份版本号迟早会漂移，而
 * 「界面显示的版本」恰好是用户报 bug 时会引用、也最容易造假的那个字段。读不到时
 * 回退到 `0.0.0-unknown`，绝不抛错——标题栏少一个数字不该让程序起不来。
 *
 * dist/ 与 src/ 到仓库根的相对深度都是 2 层（dist/cli/… 与 src/cli/…），所以同一段
 * 路径在编译前后都成立；`new URL(..., import.meta.url)` 保证不依赖进程 cwd。
 */

import { readFileSync } from 'node:fs';

const FALLBACK = '0.0.0-unknown';

/** 读 package.json 的 version；任何失败都降级为 FALLBACK。结果缓存，只读一次盘。 */
export function readVersion(): string {
  if (cached !== undefined) return cached;
  cached = FALLBACK;
  try {
    const url = new URL('../package.json', import.meta.url);
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null) {
      const value = (parsed as { version?: unknown }).version;
      if (typeof value === 'string' && value !== '') cached = value;
    }
  } catch {
    // 打包产物里可能没有 package.json，或 JSON 损坏——两种都按未知版本处理。
  }
  return cached;
}

let cached: string | undefined;
