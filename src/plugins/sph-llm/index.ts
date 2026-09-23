/**
 * sph-llm：三种上游协议的客户端。
 *
 * 宿主不选适配器。换协议或换传输，替换这个插件并提供同名服务即可。
 */
import type { PluginApi } from '../types.js';
import { MODEL_SERVICE, type ModelClientOptions, type ModelService } from '../services.js';
import { anthropicAdapter } from './anthropic.js';
import { openaiAdapter } from './openai.js';
import { responsesAdapter } from './responses.js';
import { createSseClient, type ProtocolAdapter } from './stream-client.js';

const adapters = new Map<string, ProtocolAdapter>([
  ['chat-completions', openaiAdapter],
  ['responses', responsesAdapter],
  ['anthropic-messages', anthropicAdapter],
]);

/** 注册或覆盖一种上游协议适配器。同名后写覆盖前写。 */
export function registerAdapter(api: string, adapter: ProtocolAdapter): void {
  adapters.set(api, adapter);
}

/** 按协议构造客户端。三种协议共享同一 LlmClient 面。 */
export function createClient(options: ModelClientOptions): ReturnType<ModelService['createClient']> {
  const { api, headers, ...conn } = options;
  const adapter = adapters.get(api);
  if (!adapter) throw new Error(`unknown api protocol: ${api}`);
  return createSseClient(adapter, {
    ...conn,
    headers: headers ?? {},
  });
}

/** 插件入口。宿主按 `src/plugins/sph-llm/` 装载。 */
export default function setup(api: PluginApi): void {
  const service: ModelService = { createClient };
  api.provide(MODEL_SERVICE, service);
}
