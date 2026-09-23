/**
 * 会话标题：终端 tab 的常驻名字。
 *
 * 对齐 Claude Code / Codex 的做法——首轮回复后用一次廉价 LLM 调用把「用户请求 +
 * 助手回复」概括成 3-8 词的标题，随会话持久化（resume 直接回放，不重新生成）。
 * 生成是装饰性开销：失败静默返回 undefined，绝不打扰主流程。
 */

import type { LlmClient, TokenUsage } from '../sph-llm/openai.js';

/** 喂给标题模型的原文采样上限：概括主题足够，长回复不追加成本。 */
export const TITLE_SOURCE_SAMPLE_CHARS = 1200;
/** 标题显示上限：codex 的 thread title 也按 48 字符截断，tab 栏更窄，宁短勿长。 */
export const SESSION_TITLE_MAX_CHARS = 48;

const SESSION_TITLE_SYSTEM = [
  'You name coding-agent sessions for terminal tabs.',
  'Given the user request and the assistant reply, write a concise title (3-8 words) naming the task.',
  '- Reply in the same language as the user request.',
  '- Plain text only: no quotes, no trailing punctuation, no markdown.',
  '- Do not call any tools; answer in text even though tools are attached.',
  'Reply with the title only.',
].join('\n');

/**
 * 清洗后才能进 OSC 转义序列（对齐 codex terminal_title 的净化面）：控制字符可能
 * 终止或重塑转义序列，bidi/隔离符能视觉重排标题；`|` 是我们的标题分隔符，出现即折成 `/`。
 */
export function sanitizeSessionTitle(raw: string): string {
  let cleaned = raw
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\|/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
  // 模型爱给标题包一层引号（system prompt 禁不住），展示前剥掉成对的包裹引号。
  cleaned = cleaned.replace(/^["'“”«»„]+/, '').replace(/["'“”«»„]+$/, '').trim();
  const chars = [...cleaned];
  if (chars.length <= SESSION_TITLE_MAX_CHARS) return cleaned;
  return chars.slice(0, SESSION_TITLE_MAX_CHARS).join('').trim();
}

function clampSource(text: string): string {
  const chars = [...text];
  return chars.length <= TITLE_SOURCE_SAMPLE_CHARS ? text : chars.slice(0, TITLE_SOURCE_SAMPLE_CHARS).join('');
}

export interface SessionTitleOptions {
  /** 标题调用也是真花钱，走与 review/compaction 同一条辅助用量记账。 */
  onUsage?: (usage: TokenUsage) => void;
}

/** 首轮交换后生成会话标题；解析不出可见文本或调用失败时返回 undefined。 */
export async function generateSessionTitle(
  client: LlmClient,
  userPrompt: string,
  assistantReply: string,
  options?: SessionTitleOptions,
): Promise<string | undefined> {
  const sources = [
    userPrompt.trim() === '' ? undefined : `user: ${clampSource(userPrompt)}`,
    assistantReply.trim() === '' ? undefined : `assistant: ${clampSource(assistantReply)}`,
  ].filter(Boolean);
  if (sources.length === 0) return undefined;
  try {
    const reply = await client.complete(
      [
        { role: 'system', content: SESSION_TITLE_SYSTEM },
        { role: 'user', content: sources.join('\n\n') },
      ],
      [],
    );
    if (reply.usage) options?.onUsage?.(reply.usage);
    return sanitizeSessionTitle(reply.text ?? '') || undefined;
  } catch {
    return undefined;
  }
}
