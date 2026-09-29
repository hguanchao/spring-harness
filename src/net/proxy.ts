/**
 * 出站代理装配。Node 内置 fetch 不读 HTTP(S)_PROXY 环境变量（那个开关要到 Node 24+ 才有），
 * 所以「配了代理」必须显式装一个 undici dispatcher 才生效。
 *
 * 走全局 dispatcher 而不是逐个 fetch 传参：sph 的出网点有三处（LLM 流、模型目录、
 * web_search），全局装配让调用方零感知，之后新增出网点也自动被覆盖。
 *
 * undici 按需加载：bootstrap 静态 import 本文件时还不拉 50ms+ 的 HTTP 栈，
 * `--help` 和会话列表也不该为代理装配付钱。真正出网前（applyProxy）再装。
 */

/**
 * undici 默认 allowH2=true。不少中转 / 本地代理的 CONNECT 隧道只稳 HTTP/1.1，
 * ALPN 谈到 h2 后握手直接失败，表现就是 `fetch failed`。zcode / 多数 Python 客户端
 * 走 HTTP/1.1，所以同一网关它们没事。
 */
const dispatcherOpts = {
  connections: 8,
  keepAliveTimeout: 30_000,
  pipelining: 0,
  allowH2: false,
  connect: { timeout: 20_000 },
} as const;

/** 标准代理环境变量是否存在（大小写都认，与 undici 自身的读取习惯一致）。 */
function hasEnvProxy(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy);
}

type UndiciDispatcher = {
  Agent: new (opts: typeof dispatcherOpts) => unknown;
  EnvHttpProxyAgent: new (opts: Record<string, unknown>) => unknown;
  setGlobalDispatcher: (dispatcher: unknown) => void;
};

let undici: UndiciDispatcher | undefined;
let undiciLoading: Promise<UndiciDispatcher> | undefined;
/** unset = 启动时没装 dispatcher；第一次出网再装直连 keepalive。 */
let dispatcherMode: 'unset' | 'direct' | 'proxy' = 'unset';

async function loadUndici(): Promise<UndiciDispatcher> {
  if (undici) return undici;
  undiciLoading ??= import('undici').then((mod) => {
    undici = mod as unknown as UndiciDispatcher;
    return undici;
  });
  return undiciLoading;
}

async function installKeepAlive(): Promise<void> {
  const { Agent, setGlobalDispatcher } = await loadUndici();
  setGlobalDispatcher(new Agent(dispatcherOpts));
  dispatcherMode = 'direct';
}

/**
 * 按配置装配全局代理；bootstrap 在 loadConfig 之后调用一次，重复调用只是替换 dispatcher。
 * - 显式空串 = 用户点名直连：装 keepalive，环境变量完全不参与（逃生舱必须绝对可靠）；
 * - 显式 URL = http/https 目标都走它，NO_PROXY 环境变量仍可按主机排除；
 * - 未配置 = 有标准环境变量才装（HTTP(S)_PROXY / NO_PROXY 交给 undici 解析）；
 *   否则启动不装 undici，第一次出网再装直连 keepalive。
 */
export async function applyProxy(
  configProxy: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (configProxy === '') {
    await installKeepAlive();
    return;
  }
  if (configProxy !== undefined) {
    const { EnvHttpProxyAgent, setGlobalDispatcher } = await loadUndici();
    setGlobalDispatcher(new EnvHttpProxyAgent({
      httpProxy: configProxy,
      httpsProxy: configProxy,
      ...dispatcherOpts,
    }));
    dispatcherMode = 'proxy';
    return;
  }
  if (hasEnvProxy(env)) {
    const { EnvHttpProxyAgent, setGlobalDispatcher } = await loadUndici();
    setGlobalDispatcher(new EnvHttpProxyAgent(dispatcherOpts));
    dispatcherMode = 'proxy';
    return;
  }
}

/** 直连出网前装 keepalive + 关 H2。代理路径已由 applyProxy 装过，这里不再覆盖。 */
export async function ensureDirectDispatcher(): Promise<void> {
  if (dispatcherMode !== 'unset') return;
  await installKeepAlive();
}
