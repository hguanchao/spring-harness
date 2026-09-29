/**
 * 有人值守的 Approver：把 headless 里「无人可问」的接缝接到 TUI 浮层上。
 *
 * 判定顺序与 HeadlessApprover 一致：
 *   - 规则先求值：deny 一票否决，ask 强制问人，allow 直接放行；
 *   - 非受审工具直接放行（文件类工具由沙箱管，但规则里的 deny/ask 对它们同样生效）；
 *   - 只读 shell 命令免问（要拦就写 ask / deny 规则）；
 *   - 沙箱兜得住时免问（要 `sandbox_auto_allow` 显式打开才生效）；
 *   - yolo 放行，auto 先过 LLM 审查器（否决/不可用则升级到人审），ask 问人。
 *
 * 「总是允许」分三层，对应三种不同的记忆：
 *   - `sessionGrants`：本会话有效，进程退出即消失；
 *   - `projectGrants`：本项目有效，写 `<项目>/.sph/permissions.json`，下次开会话仍然生效；
 *   - 项目规则：本项目有效且**可复用**——写项目级 `[permissions].allow`，换个参数也免问。
 * 三层存的都是**动作键**或**规则**，不是工具名——见 approvalScopeKey 的注释。
 */

import type {
  ApprovalMode,
  ApprovalRequest,
  Approver,
  ApproverEnv,
  PermissionRules,
  RuleEnv,
  RuleLayers,
} from '@/permission/policy.js';
import {
  approvalScopeKey,
  evaluateRules,
  isReadOnlyCommand,
  isShellTool,
  REVIEWED_TOOLS,
  sandboxCovers,
  suggestAllowRule,
} from '@/permission/policy.js';
import type { ClassifierVerdict } from '@/permission/auto.js';
import type { GrantStore } from '@/permission/store.js';
import type { SandboxMode } from '@/sandbox/types.js';

/** 浮层里选了什么。授权与规则的落盘由审批器负责，界面只管问。 */
export type ApprovalChoice = 'deny' | 'once' | 'session' | 'project' | 'rule';

export interface ApprovalUi {
  /** 当前审批模式（`/permission` 可随时改）。 */
  approvalMode(): ApprovalMode;
  /**
   * 弹审批浮层。`note` 用于展示审查器给出的否决理由；`suggestedRule` 非空时界面多给一项
   * 「总是允许这类动作」，选中即由审批器把它写进项目级规则。
   */
  requestApproval(request: ApprovalRequest, note?: string, suggestedRule?: string): Promise<ApprovalChoice>;
  requestAnswer(question: string): Promise<string>;
  /** 当前沙箱档位与免问开关；沙箱是启动参数，运行中不变。 */
  sandbox(): { mode: SandboxMode; autoAllow: boolean };
}

/** 规则写回：把一条规则追加进项目级 `[permissions].allow`。 */
export type RuleWriter = (rule: string) => { path: string; added: boolean };

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
    private readonly env: ApproverEnv = {},
    /** 省略即不给「提升为规则」这一项。 */
    private readonly writeRule?: RuleWriter,
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
    const rule = evaluateRules(this.env.layers ?? {}, request, this.env.ruleEnv);
    // deny 是硬边界：优先于一切，包括 yolo 和已经批准过的授权。
    if (rule === 'deny') return false;
    // ask 也优先于 yolo 与授权：用户明确写下「这个必须先问我」，那是比一次模式切换更具体的意图。
    if (rule === 'ask') {
      return this.prompt(request, 'A permission rule requires approval for this.');
    }
    if (rule === 'allow') return true;

    // 授权命中先于一切：它记录的是用户对**这个具体动作**的显式批准。
    // escalate 也走这里——它此前只弹窗、从不查询，于是浮层里的「总是允许」记了却永远不生效。
    const key = approvalScopeKey(request);
    if (this.sessionGrants.has(key) || this.projectGrants.has(key)) return true;
    if (request.tool === 'escalate') return this.prompt(request);
    if (!REVIEWED_TOOLS.has(request.tool)) return true;
    // 只读命令在所有模式下免问；要拦就写 ask / deny 规则（规则已在上面求值过）。
    if (isShellTool(request.tool) && request.command !== undefined && isReadOnlyCommand(request.command)) {
      return true;
    }
    // 沙箱兜得住就不问。默认关闭：sph 的沙箱是同主机文件策略，不是进程隔离。
    if (sandboxCovers(request, this.env)) return true;

    const mode = this.ui.approvalMode();
    if (mode === 'yolo') return true;
    if (mode === 'auto' && this.classifier) {
      const verdict = await this.classifier(request);
      if (verdict.allowed) return true;
      return this.prompt(request, `Reviewer: ${verdict.reason ?? 'denied'}`);
    }
    return this.prompt(request);
  }

  /** 弹浮层并按选择落盘。 */
  private async prompt(request: ApprovalRequest, note?: string): Promise<boolean> {
    const suggested = this.writeRule === undefined ? undefined : suggestAllowRule(request);
    const choice = await this.ui.requestApproval(request, note, suggested);
    switch (choice) {
      case 'session':
        this.allowForSession(request);
        return true;
      case 'project':
        this.allowForProject(request);
        return true;
      case 'rule':
        if (suggested !== undefined) this.writeRule?.(suggested);
        return true;
      case 'once':
        return true;
      default:
        return false;
    }
  }

  async ask(prompt: string): Promise<string> {
    return this.ui.requestAnswer(prompt);
  }
}

export type { PermissionRules, RuleEnv, RuleLayers };
