/**
 * 有人值守的 Approver 实现：把 headless 里「无人可问，一律拒绝」的三处接缝接到人身上。
 *
 * 与 HeadlessApprover 的差别只在「谁来裁决」，判定顺序保持一致：
 *   - 非受审工具直接放行（文件类工具由沙箱管，不走审批）；
 *   - yolo 放行；
 *   - auto 先过 LLM 审查器，审查器否决/不可用时**升级到人审**——fail-closed 的语义是
 *     「不静默放行」，而不是「沉默拒绝」；终端前有人时，让人定夺比直接拒绝更有用；
 *   - ask 直接问人。
 * 唯一的状态是「本会话总是允许」的集合（审批浮层选 a），避免重复问同一条命令。
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
  requestPlan(plan: string): Promise<{ approved: boolean; feedback?: string }>;
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
      return this.ui.requestApproval(request, `审查器：${verdict.reason ?? 'denied'}`);
    }
    return this.ui.requestApproval(request);
  }

  async ask(prompt: string): Promise<string> {
    return this.ui.requestAnswer(prompt);
  }

  async decidePlan(plan: string): Promise<{ approved: boolean; feedback?: string }> {
    return this.ui.requestPlan(plan);
  }
}
