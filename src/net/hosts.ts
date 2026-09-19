/** 已知官方 / 网关主机名。匹配逻辑只从这里读，避免字面量散落。 */

const HOST_ANTHROPIC = 'anthropic.com';
const HOST_ANTHROPIC_API = 'api.anthropic.com';
export const HOST_OPENAI_API = 'api.openai.com';
export const HOST_OPENROUTER = 'openrouter.ai';
const HOST_GOOGLE_APIS = 'googleapis.com';
const HOST_GOOGLE_GENERATIVE = 'generativelanguage';
const HOST_DEEPSEEK = 'deepseek.com';
const HOST_GROQ = 'groq.com';
const HOST_TOGETHER_XYZ = 'together.xyz';
const HOST_TOGETHER_AI = 'together.ai';
const HOST_FIREWORKS = 'fireworks.ai';
const HOST_MISTRAL = 'mistral.ai';

export const SPH_USER_AGENT = 'sph/0.1 (+https://github.com/hguanchao/spring-harness)';

export function isHostOrSubdomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export function isAnthropicHost(host: string): boolean {
  return host === HOST_ANTHROPIC_API || isHostOrSubdomain(host, HOST_ANTHROPIC);
}

export function isOpenAiApiHost(host: string): boolean {
  return isHostOrSubdomain(host, HOST_OPENAI_API);
}

export function isOpenRouterHost(host: string): boolean {
  return isHostOrSubdomain(host, HOST_OPENROUTER);
}

export function isGoogleGenerativeHost(host: string): boolean {
  return host.includes(HOST_GOOGLE_APIS) || host.includes(HOST_GOOGLE_GENERATIVE);
}

export function isChatCompletionsGatewayHost(host: string): boolean {
  return (
    host.includes(HOST_DEEPSEEK)
    || host.includes(HOST_GROQ)
    || host.includes(HOST_TOGETHER_XYZ)
    || host.includes(HOST_TOGETHER_AI)
    || host.includes(HOST_FIREWORKS)
    || host.includes(HOST_MISTRAL)
  );
}

