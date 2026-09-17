import type { ApiProtocol } from '../config/load.js';
import type { SessionAffinityFormat } from './compat.js';

export interface EndpointPreset {
  api: ApiProtocol;
  headers?: Record<string, string>;
  sessionAffinity?: SessionAffinityFormat;
}

/**
 * 按 base_url 主机推断协议与常见头。不是厂商 SDK，只是网关适配。
 * 未知主机返回 undefined，调用方保持 config 里的 api。
 */
export function inferEndpointPreset(baseUrl: string): EndpointPreset | undefined {
  let host = '';
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (host === 'api.anthropic.com' || host.endsWith('.anthropic.com')) {
    return { api: 'anthropic-messages' };
  }
  if (host === 'api.openai.com' || host.endsWith('.api.openai.com')) {
    return { api: 'chat-completions' };
  }
  if (host.includes('openrouter.ai')) {
    return {
      api: 'chat-completions',
      sessionAffinity: 'openrouter',
      headers: { 'HTTP-Referer': 'https://github.com/spring-harness', 'X-Title': 'sph' },
    };
  }
  if (host.includes('deepseek.com') || host.includes('groq.com') || host.includes('together.xyz')
    || host.includes('fireworks.ai') || host.includes('mistral.ai') || host.includes('together.ai')) {
    return { api: 'chat-completions' };
  }
  if (host.includes('googleapis.com') || host.includes('generativelanguage')) {
    return { api: 'chat-completions' };
  }
  return undefined;
}

/** 把预设头叠进用户头：用户同名键优先。 */
export function mergePresetHeaders(baseUrl: string, headers: Record<string, string>): Record<string, string> {
  const preset = inferEndpointPreset(baseUrl);
  if (!preset?.headers) return headers;
  return { ...preset.headers, ...headers };
}
