/**
 * 有人值守的 Approver：把 headless 里「无人可问」的接缝接到 TUI 浮层上。
 *
 * 判定顺序与 HeadlessApprover 一致：
 *   - 非受审工具直接放行（文件类工具由沙箱管，不走审批）；
 *   - yolo 放行；
 *   - auto 先过 LLM 审查器，审查器否决/不可用时**升级到人审**（fail-closed = 不静默放行）；
 *   - ask 直接问人。
 * 唯一状态是「本会话总是允许」的工具集合（审批浮层选 always），避免重复问同一条命令。
 */

import type { Approver, ApprovalMode, ApprovalRequest } from '../approval/policy.js';
import { REVIEWED_TOOLS } from '../approval/policy.js';
import type { ClassifierVerdict } from '../approval/auto.js';

export interface ApprovalUi {
  /** 当前审批模式（`/approval` 可随时改）。 */
  approvalMode(): ApprovalMode;
  /** note 用于把审查器给出的否决理由一并展示。 */
  requestApproval(request: ApprovalRequest, note?: string): Promise<boolean>;
  requestAnswer(question: string): Promise<string>;
}

export class InteractiveApprover implements Approver {
  private readonly allowedTools = new Set<string>();

  constructor(
    private readonly ui: ApprovalUi,
    private readonly classifier?: (request: ApprovalRequest) => Promise<ClassifierVerdict>,
  ) {}

  allowForSession(tool: string): void {
    this.allowedTools.add(tool);
  }

  async decide(request: ApprovalRequest): Promise<boolean> {
    if (request.tool === 'escalate') return this.ui.requestApproval(request);
    if (!REVIEWED_TOOLS.has(request.tool)) return true;
    if (this.allowedTools.has(request.tool)) return true;
    const mode = this.ui.approvalMode();
    if (mode === 'yolo') return true;
    if (mode === 'auto' && this.classifier) {
      const verdict = await this.classifier(request);
      if (verdict.allowed) return true;
      return this.ui.requestApproval(request, `Reviewer: ${verdict.reason ?? 'denied'}`);
    }
    return this.ui.requestApproval(request);
  }

  async ask(prompt: string): Promise<string> {
    return this.ui.requestAnswer(prompt);
  }
}
