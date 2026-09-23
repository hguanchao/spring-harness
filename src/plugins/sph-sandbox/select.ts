import { SandboxError } from '../../sandbox/types.js';

export interface RunnerCandidate<T extends string> {
  id: T;
  usable: () => Promise<boolean>;
}

/**
 * 按顺序探，第一个能用的留下。全部失败就拒绝，不能改成无围栏执行。
 * 调用方负责把结果缓存到这次进程：装上或卸掉 runner 要重启才换。
 */
export async function selectRunner<T extends string>(chain: readonly RunnerCandidate<T>[]): Promise<T> {
  for (const candidate of chain) {
    if (await candidate.usable()) return candidate.id;
  }
  const names = chain.map((candidate) => candidate.id).join(', ');
  throw new SandboxError(`no usable same-host sandbox runner (${names}); pass --sandbox off`);
}
