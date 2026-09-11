import type { ApprovalRequest } from './policy.js';
import type { LlmClient, TokenUsage } from '../llm/openai.js';

export interface ClassifierVerdict {
  allowed: boolean;
  reason?: string;
}

export interface ClassifierOptions {
  /** 分类器调用产生的用量：审查器是额外开销，应当可见可统计。 */
  onUsage?: (usage: TokenUsage) => void;
}

const CLASSIFIER_SYSTEM = [
  'You are the safety reviewer of an agent. One tool call is pending; decide allow or deny.',
  'Allow: reads, listings, tests, builds, installs, git status/diff/log/commit, ordinary dev commands inside the workspace.',
  'Deny: deleting data or files, force-push, handling or exfiltrating credentials/secrets, destructive or clearly malicious actions, escaping the workspace.',
  'Reply with exactly one line: ALLOW or DENY: <short reason>.',
].join(' ');

/**
 * auto 模式的 LLM 审批分类器。
 * 解析不出明确结论或调用失败时一律 fail-closed（拒绝）——审查器沉默不能等于放行。
 */
export function createLlmClassifier(
  client: LlmClient,
  options?: ClassifierOptions,
): (request: ApprovalRequest) => Promise<ClassifierVerdict> {
  return async (request: ApprovalRequest): Promise<ClassifierVerdict> => {
    try {
      const reply = await client.complete(
        [
          { role: 'system', content: CLASSIFIER_SYSTEM },
          {
            role: 'user',
            content: [
              `tool: ${request.tool}`,
              request.command ? `command: ${request.command}` : '',
              request.path ? `path: ${request.path}` : '',
            ].filter(Boolean).join('\n'),
          },
        ],
        [],
      );
      if (reply.usage) options?.onUsage?.(reply.usage);
      const line = (reply.text ?? '').trim().split(/\r?\n/)[0] ?? '';
      if (/^allow\b/i.test(line)) return { allowed: true };
      const deny = /^deny\b[:\s]*(.*)/i.exec(line);
      if (deny) return { allowed: false, reason: deny[1]?.trim() || 'reviewer denied' };
      return { allowed: false, reason: 'reviewer gave no clear verdict' };
    } catch (error) {
      return { allowed: false, reason: `reviewer unavailable: ${error instanceof Error ? error.message : String(error)}` };
    }
  };
}
