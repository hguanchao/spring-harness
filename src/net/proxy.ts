/**
 * 出站代理装配。Node 内置 fetch 不读 HTTP(S)_PROXY 环境变量（那个开关要到 Node 24+ 才有），
 * 所以「配了代理」必须显式装一个 undici dispatcher 才生效。
 *
 * 走全局 dispatcher 而不是逐个 fetch 传参：sph 的出网点有三处（LLM 流、模型目录、
 * web_fetch），全局装配让调用方零感知，之后新增出网点也自动被覆盖。
 */
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

/** 标准代理环境变量是否存在（大小写都认，与 undici 自身的读取习惯一致）。 */
function hasEnvProxy(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy);
}

/**
 * 按配置装配全局代理；bootstrap 在 loadConfig 之后调用一次，重复调用只是替换 dispatcher。
 * - 显式空串 = 用户点名直连：什么都不装，环境变量完全不参与（逃生舱必须绝对可靠）；
 * - 显式 URL = http/https 目标都走它，NO_PROXY 环境变量仍可按主机排除；
 * - 未配置 = 有标准环境变量才装（HTTP(S)_PROXY / NO_PROXY 交给 undici 解析），否则保持默认直连。
 */
export function applyProxy(
  configProxy: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (configProxy === '') return;
  if (configProxy !== undefined) {
    setGlobalDispatcher(new EnvHttpProxyAgent({ httpProxy: configProxy, httpsProxy: configProxy }));
    return;
  }
  if (hasEnvProxy(env)) setGlobalDispatcher(new EnvHttpProxyAgent());
}
