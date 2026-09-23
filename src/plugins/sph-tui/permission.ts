/**
 * 有人值守的 Approver：把 headless 里「无人可问」的接缝接到 TUI 浮层上。
 *
 * 判定顺序与 HeadlessApprover 一致：
 *   - 非受审工具直接放行（文件类工具由沙箱管，不走审批）；
 *   - yolo 放行；
 *   - auto 先过 LLM 审查器，审查器否决/不可用时**升级到人审**（fail-closed = 不静默放行）；
 *   - ask 直接问人。
 *
 * 状态分两层，对应浮层里的两个「总是允许」：
 *   - `sessionGrants`：本会话有效，进程退出即消失；
 *   - `projectGrants`：本项目有效，落 `~/.sph/permissions.json`，下次开会话仍然生效。
 * 两层存的都是**动作键**（approvalScopeKey），不是工具名——见那里的注释。
 */

import type { Approver, ApprovalMode, ApprovalRequest, PermissionRules } from '../../permission/policy.js';
import { approvalScopeKey, evaluateRules, REVIEWED_TOOLS } from '../../permission/policy.js';
import type { ClassifierVerdict } from '../../permission/auto.js';
import type { GrantStore } from '../../permission/store.js';

export interface ApprovalUi {
  /** 当前审批模式（`/permission` 可随时改）。 */
  approvalMode(): ApprovalMode;
  /** note 用于把审查器给出的否决理由一并展示。 */
  requestApproval(request: ApprovalRequest, note?: string): Promise<boolean>;
  requestAnswer(question: string): Promise<string>;
}

export class InteractiveApprover implements Approver {
  /** 本会话内批准的动作键。 */
  private readonly sessionGrants = new Set<string>();
  /** 本项目内持久批准的动作键（构造时从磁盘读入）。 */
  private readonly projectGrants: Set<string>;

  constructor(
    private readonly ui: ApprovalUi,
    private readonly classifier?: (request: ApprovalRequest) => Promise<ClassifierVerdict>,
    /** 省略即不落盘：headless 与单测走这条路。 */
    private readonly grants?: GrantStore,
    /** `[permissions]` 规则；省略即无规则。 */
    private readonly rules?: PermissionRules,
  ) {
    this.projectGrants = new Set(grants?.load() ?? []);
  }

  /** 「本会话」：只活在内存里。 */
  allowForSession(request: ApprovalRequest): void {
    this.sessionGrants.add(approvalScopeKey(request));
  }

  /** 「本项目」：写进授权文件，下次开会话仍然有效。 */
  allowForProject(request: ApprovalRequest): void {
    const key = approvalScopeKey(request);
    this.projectGrants.add(key);
    this.grants?.add(key);
  }

  async decide(request: ApprovalRequest): Promise<boolean> {
    const rule = evaluateRules(this.rules, request);
    // deny 是硬边界：优先于一切，包括 yolo 和已经批准过的授权。
    if (rule === 'deny') return false;
    // ask 也优先于 yolo：用户明确写下「这个必须先问我」，那是比一次模式切换更具体的意图。
    if (rule === 'ask') {
      return this.ui.requestApproval(request, 'A permission rule requires approval for this.');
    }
    if (rule === 'allow') return true;

    // 授权命中先于一切：它记录的是用户对**这个具体动作**的显式批准。
    // escalate 也走这里——它此前只弹窗、从不查询，于是浮层里的「总是允许」记了却永远不生效。
    const key = approvalScopeKey(request);
    if (this.sessionGrants.has(key) || this.projectGrants.has(key)) return true;
    if (request.tool === 'escalate') return this.ui.requestApproval(request);
    if (!REVIEWED_TOOLS.has(request.tool)) return true;
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
