/**
 * 配置层共用的错误类型。
 *
 * 单独成文件是为了让 `registry.ts` 与 `load.ts` 都能抛同一种错，而不必互相 import。
 * 调用方按类型分流：`ConfigError` 一律翻译成退出码 2（用法/配置错误），其余异常继续上抛。
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
