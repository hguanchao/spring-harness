/**
 * sph-llm：三种上游协议的客户端。
 *
 * 宿主不选适配器。换协议或换传输，替换这个插件并提供同名服务即可。
 *
 * 入口不静态拉 openai / anthropic / stream-client：那条图含 undici。
 * 第一次 complete() 再装适配器；createClient 仍同步，返回的是延迟包装。
 */
import type { PluginApi } from '../types.js';
import type { LlmClient } from '../../llm/client.js';
import { MODEL_SERVICE, type ModelClientOptions, type ModelService } from '../services.js';
import type { ProtocolAdapter } from './stream-client.js';

const adapters = new Map<string, ProtocolAdapter>();
const loaders: Record<string, () => Promise<ProtocolAdapter>> = {
  'chat-completions': async () => (await import('./openai.js')).openaiAdapter,
  responses: async () => (await import('./responses.js')).responsesAdapter,
  'anthropic-messages': async () => (await import('./anthropic.js')).anthropicAdapter,
};

/** 注册或覆盖一种上游协议适配器。同名后写覆盖前写。 */
export function registerAdapter(api: string, adapter: ProtocolAdapter): void {
  adapters.set(api, adapter);
}

async function resolveAdapter(api: string): Promise<ProtocolAdapter> {
  const registered = adapters.get(api);
  if (registered) return registered;
  const load = loaders[api];
  if (!load) throw new Error(`unknown api protocol: ${api}`);
  const adapter = await load();
  adapters.set(api, adapter);
  return adapter;
}

/** 按协议构造客户端。三种协议共享同一 LlmClient 面。 */
export function createClient(options: ModelClientOptions): LlmClient {
  let inner: LlmClient | undefined;
  let pending: Promise<LlmClient> | undefined;
  const getInner = (): Promise<LlmClient> => {
    if (inner) return Promise.resolve(inner);
    pending ??= (async () => {
      const { api, headers, ...conn } = options;
      const [adapter, { createSseClient }] = await Promise.all([
        resolveAdapter(api),
        import('./stream-client.js'),
      ]);
      inner = createSseClient(adapter, { ...conn, headers: headers ?? {} });
      return inner;
    })();
    return pending;
  };
  return {
    complete(messages, tools, signal, onDelta, onRetry) {
      return getInner().then((client) => client.complete(messages, tools, signal, onDelta, onRetry));
    },
  };
}

/**
 * 插件入口。宿主按 `src/plugins/sph-llm/` 装载。
 *
 * 导出成对象形态是为了挂 `description`：函数形态的默认导出没有地方写自述，
 * 而那句自述正是 `/plugins` 明细里的第一行。
 */
function setup(api: PluginApi): void {
  const service: ModelService = { createClient };
  api.provide(MODEL_SERVICE, service);
}

export default {
  description: 'Model clients for the upstream chat protocols, loaded on first use.',
  setup,
};
