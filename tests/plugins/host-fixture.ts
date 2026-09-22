/**
 * 测试用的宿主事实。
 *
 * 用**真实实现**而不是桩：`mergeChildEnv` 是凭据擦除（spawn 路径必须走真的，否则这里测的
 * 就不是生产路径），`canonicalize` 决定路径比较是否成立。只有信任判定给固定值——它读的是
 * 宿主 config.toml，测试不该被开发机的信任状态影响。
 */

import { mergeChildEnv } from '../../src/sandbox/env.js';
import type { PluginHostFacts } from '../../src/plugins/types.js';
import { canonicalize } from '../../src/workspace/boundary.js';

export function testHostFacts(overrides: Partial<PluginHostFacts> = {}): PluginHostFacts {
  return {
    sphHome: process.cwd(),
    mergeChildEnv: (extra?: Record<string, string>) => mergeChildEnv(extra),
    canonicalize: (path: string) => canonicalize(path),
    isWorkspaceTrusted: () => true,
    ...overrides,
  };
}
