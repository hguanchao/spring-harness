export type ApprovalMode = 'ask' | 'auto' | 'yolo';

/** 合法取值清单（配置校验、CLI 校验、命令面板共用一份，避免三处各写一遍）。 */
export const APPROVAL_MODES: readonly ApprovalMode[] = ['ask', 'auto', 'yolo'];

/**
 * 子代理的审批策略。
 *
 * `inherit`：复用父会话的审批器，包括父会话已经批准过的授权——子代理是父会话派出去的
 * 同一件事的延续。`strict`：fail-closed，受审工具一律拒绝、不弹窗、不共享父会话的授权
 * ——后台子代理不该把交互决策传下去，也不该悄悄扩大父会话的授权面（对齐 dsh 的强制 never）。
 */
export const SUBAGENT_APPROVAL_POLICIES = ['inherit', 'strict'] as const;
export type SubagentApprovalPolicy = (typeof SUBAGENT_APPROVAL_POLICIES)[number];

/** 需要审查的工具：ask 模式问人，auto 模式过分类器，yolo 直接放行。 */
export const REVIEWED_TOOLS = new Set(['shell', 'web_search', 'mcp', 'enter_plan_mode']);

export interface ApprovalRequest {
  tool: string;
  command?: string;
  path?: string;
}

/**
 * 权限规则：`[permissions]` 里的 allow / ask / deny 三张表。
 *
 * 与「模式」的分工——模式（ask/auto/yolo）是**全局的当下态度**，规则是**针对具体动作的
 * 长期意图**。用户写下的规则比一次模式切换更具体，所以优先级更高；deny 尤其如此：
 * 它是「这个绝对不能做」的硬边界，必须连 yolo 都绕不过去。
 * （grok-build 的注释也是这么定的：deny 在任何模式之前强制拒绝。）
 */
export type RuleAction = 'allow' | 'ask' | 'deny';

export interface PermissionRules {
  allow: readonly string[];
  ask: readonly string[];
  deny: readonly string[];
}

export const EMPTY_RULES: PermissionRules = Object.freeze({ allow: [], ask: [], deny: [] });

/**
 * 规则 pattern 的匹配对象：与 approvalScopeKey 取同一份细节，两处口径必须一致，
 * 否则「批准过的命令」和「被规则匹配的命令」会不是同一个东西。
 */
function approvalDetail(request: ApprovalRequest): string {
  return (request.command ?? request.path ?? '').trim().replace(/\s+/g, ' ');
}

/** `*` 任意长度、`?` 单字符；其余字符按字面匹配。 */
function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (const ch of pattern) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, 's');
}

/**
 * 一条规则是否命中。
 *
 * 语法 `<tool>` 或 `<tool>:<pattern>`，**只按第一个冒号切分**：shell 命令里冒号很常见
 * （`git commit -m "fix: x"`），从右边切会把命令切碎。不写 pattern 就是「这个工具的全部」，
 * 写了就按通配匹配——不带通配符即精确匹配，精确是更安全的默认值。
 */
function ruleMatches(entry: string, request: ApprovalRequest): boolean {
  const sep = entry.indexOf(':');
  const tool = (sep === -1 ? entry : entry.slice(0, sep)).trim();
  if (tool === '' || tool !== request.tool) return false;
  const pattern = sep === -1 ? '' : entry.slice(sep + 1).trim();
  if (pattern === '') return true;
  return globToRegExp(pattern).test(approvalDetail(request));
}

/**
 * 按 deny > ask > allow 的次序求值；无命中返回 undefined（交回模式与授权集合决定）。
 *
 * 顺序就是优先级，两个参考实现（grok-build、Claude Code）都是这个次序。
 */
export function evaluateRules(
  rules: PermissionRules | undefined,
  request: ApprovalRequest,
): RuleAction | undefined {
  if (!rules) return undefined;
  if (rules.deny.some((entry) => ruleMatches(entry, request))) return 'deny';
  if (rules.ask.some((entry) => ruleMatches(entry, request))) return 'ask';
  if (rules.allow.some((entry) => ruleMatches(entry, request))) return 'allow';
  return undefined;
}

/**
 * 「本会话总是允许」的作用域键。
 *
 * 为什么不能拿**工具名**当键：对 `shell` 点一次「总是允许」，等于放行本会话的所有命令，
 * 包括 `rm -rf`。用户以为自己只批准了眼前这一条，实际签出的是整个工具——审批机制最容易
 * 漏的就是这个洞。所以按每个工具真正的危险维度取键：
 *
 * - `shell`：归一化后的命令原文。换一个参数就是另一个动作，必须重新问。
 * - `escalate`：具体路径，它每次请求的本来就是一个确定的写操作。
 * - `mcp`：`server.tool`。工具名本身已经足够具体，不需要再细分。
 * - `enter_plan_mode`：不带参数，工具名就是动作本身。
 * - `web_search`：只读网络查询，没有可再细分的执行维度，按工具名记。
 *
 * 取不到细节时**退回工具名而不是造一个更宽的键**：宁可粗一点、多问一次，也不要写出
 * 一个能匹配一切的键。
 */
export function approvalScopeKey(request: ApprovalRequest): string {
  switch (request.tool) {
    case 'shell': {
      const command = (request.command ?? '').trim().replace(/\s+/g, ' ');
      return command === '' ? 'shell' : `shell ${command}`;
    }
    case 'escalate':
      return request.path ? `escalate ${request.path}` : 'escalate';
    case 'mcp':
      return request.command ? `mcp ${request.command}` : 'mcp';
    default:
      return request.tool;
  }
}

export interface Approver {
  decide(request: ApprovalRequest): Promise<boolean>;
  ask?(prompt: string): Promise<string>;
}

export class HeadlessApprover implements Approver {
  constructor(
    private readonly mode: ApprovalMode,
    private readonly classifier?: (request: ApprovalRequest) => Promise<{ allowed: boolean }>,
    private readonly rules?: PermissionRules,
  ) {}

  async decide(request: ApprovalRequest): Promise<boolean> {
    const rule = evaluateRules(this.rules, request);
    // deny 优先于一切：硬边界，连 yolo 也不该绕过去。
    if (rule === 'deny') return false;
    // headless 无人可问：ask 规则与「受审工具」同归拒绝，不静默放行。
    if (rule === 'ask') return false;
    if (rule === 'allow') return true;
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
