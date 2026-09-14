export type ApprovalMode = 'ask' | 'auto' | 'yolo';

/** 合法取值清单（配置校验、CLI 校验、命令面板共用一份，避免三处各写一遍）。 */
export const APPROVAL_MODES: readonly ApprovalMode[] = ['ask', 'auto', 'yolo'];

/** 需要审查的工具：ask 模式问人，auto 模式过分类器，yolo 直接放行。 */
export const REVIEWED_TOOLS = new Set(['shell', 'web_fetch', 'mcp']);

export interface ApprovalRequest {
  tool: string;
  command?: string;
  path?: string;
}

export interface Approver {
  decide(request: ApprovalRequest): Promise<boolean>;
  ask?(prompt: string): Promise<string>;
}

export class HeadlessApprover implements Approver {
  constructor(
    private readonly mode: ApprovalMode,
    private readonly classifier?: (request: ApprovalRequest) => Promise<{ allowed: boolean }>,
  ) {}

  async decide(request: ApprovalRequest): Promise<boolean> {
    if (request.tool === 'escalate' || request.tool === 'ask_user') return false;
    if (REVIEWED_TOOLS.has(request.tool)) {
      if (this.mode === 'yolo') return true;
      if (this.mode === 'auto') {
        if (!this.classifier) return false;
        return (await this.classifier(request)).allowed;
      }
      return false;
    }
    return true;
  }

  async ask(): Promise<string> {
    return '';
  }
}
