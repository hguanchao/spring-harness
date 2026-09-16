/**
 * 子进程环境：对齐 deepseek-harness 的 scrubbedParentEnv。
 *
 * 模型能跑 shell / MCP，子进程默认继承 process.env 就会把 SPH_API_KEY、
 * NPM_TOKEN 一类凭据带进 `env` 输出和第三方 server。显式 spec.env 叠在擦除之后，
 * 用户故意转交的密钥仍然能到目标进程。
 */

/** 名称里带这些词的环境变量一律不传给子进程（大小写不敏感，覆盖 Windows）。 */
export const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i;

const SPH_PREFIX = 'SPH_';

/** 捕获上限：shell 结果进模型前还会再 clip，这里只挡 `yes` 一类把父进程撑爆的输出。 */
export const MAX_SPAWN_CAPTURE = 2 * 1024 * 1024;

export function scrubbedParentEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (SENSITIVE_ENV_PATTERN.test(key)) continue;
    if (key.toUpperCase().startsWith(SPH_PREFIX)) continue;
    env[key] = value;
  }
  return env;
}

/** 擦除后的父环境 + 调用方显式条目（显式条目可覆盖擦除，用于 MCP 自己的密钥）。 */
export function mergeChildEnv(
  extra?: Record<string, string>,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return extra === undefined ? scrubbedParentEnv(source) : { ...scrubbedParentEnv(source), ...extra };
}

/** CreateProcessAsUserW 的 Unicode 环境块：`k=v\0k2=v2\0\0`。 */
export function windowsEnvBlock(env: Record<string, string>): Buffer {
  const body = Object.entries(env)
    .filter(([key]) => key !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join('\0');
  return Buffer.from(`${body}\0\0`, 'utf16le');
}

export function capSpawnOutput(text: string, max = MAX_SPAWN_CAPTURE): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...[truncated ${text.length - max} chars at capture]`;
}
