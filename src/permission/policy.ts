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
export const REVIEWED_TOOLS = new Set(['bash', 'pwsh', 'web_search', 'web_fetch', 'mcp', 'enter_plan_mode']);

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
 * 按顶层分隔符把复合命令拆成子命令，规则逐段匹配（对齐 Claude Code 的语义）。
 *
 * 识别的分隔符：`&&`、`||`、`;`、`|`、`|&`、`&`、换行。引号内与反斜杠转义的
 * 分隔符不是切点（`echo "a && b"` 是一条命令）；`2>&1` 里的 `&` 是文件描述符
 * 复制（跟在 `>`/`<` 后），不切；`(`、`)` 是子 shell 边界，也作为切点——
 * 里面的命令同样要被 deny 看见、被 allow 覆盖。
 *
 * 返回 undefined 表示解析不了：未闭合引号、截断的操作符（`npm test &&`）、
 * 连续分隔符（`a ;; b`）。解析不了的命令绝不能被 allow 规则静默放行。
 */
export function splitShellCommands(command: string): string[] | undefined {
  const parts: string[] = [];
  let current = '';
  /** 上一段以顶层分隔符收尾；其后紧跟分隔符（`a ;; b`、`a &&`）就是语法错误。 */
  let afterSeparator = false;
  /** 未闭合的子 shell：`a && (b` 解析不出完整命令，一律 fail-closed。 */
  let parenDepth = 0;

  const flush = (): void => {
    const trimmed = current.trim().replace(/\s+/g, ' ');
    if (trimmed !== '') parts.push(trimmed);
    current = '';
  };

  let i = 0;
  while (i < command.length) {
    const ch = command[i]!;

    // 反斜杠转义（引号外）：下一个字符并入字面量。
    if (ch === '\\' && i + 1 < command.length) {
      current += ch + command[i + 1]!;
      afterSeparator = false;
      i += 2;
      continue;
    }
    // 单引号：到下一个单引号为止全是字面量。
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return undefined;
      current += command.slice(i, end + 1);
      afterSeparator = false;
      i = end + 1;
      continue;
    }
    // 双引号：内部允许反斜杠转义。
    if (ch === '"') {
      current += ch;
      i += 1;
      let closed = false;
      while (i < command.length) {
        const inner = command[i]!;
        if (inner === '\\' && i + 1 < command.length) {
          current += inner + command[i + 1]!;
          i += 2;
          continue;
        }
        current += inner;
        i += 1;
        if (inner === '"') {
          closed = true;
          break;
        }
      }
      if (!closed) return undefined;
      afterSeparator = false;
      continue;
    }
    // 子 shell / 分组边界：也作为切点——里面的命令各归各段，deny 看得见、allow 得覆盖。
    // 括号本身不并入任何一段：'echo $(rm -rf x)' 拆出 'rm -rf x'，deny 的前缀 glob 才够得着。
    if (ch === '(') {
      flush();
      afterSeparator = false;
      parenDepth += 1;
      i += 1;
      continue;
    }
    if (ch === ')') {
      flush();
      afterSeparator = false;
      if (parenDepth > 0) parenDepth -= 1;
      i += 1;
      continue;
    }
    // 顶层分隔符。
    const pair = command.slice(i, i + 2);
    if (pair === '&&' || pair === '||' || pair === '|&') {
      if (afterSeparator) return undefined;
      flush();
      afterSeparator = true;
      i += 2;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '\n' || ch === '\r') {
      // `2>&1` 的 & 是文件描述符复制：跟在 > / < 后不切。
      const prev = i > 0 ? command[i - 1]! : '';
      if (ch === '&' && (prev === '>' || prev === '<')) {
        current += ch;
        i += 1;
        continue;
      }
      if (afterSeparator) return undefined;
      flush();
      afterSeparator = true;
      i += 1;
      continue;
    }
    if (ch !== ' ' && ch !== '\t') afterSeparator = false;
    current += ch;
    i += 1;
  }
  if (current.trim() === '') {
    if (afterSeparator) return undefined; // 截断的操作符：`npm test &&`
    if (parenDepth !== 0) return undefined; // 未闭合的子 shell：`a && (b`
    if (parts.length === 0) return command.trim() === '' ? [] : undefined;
    return parts;
  }
  flush();
  if (parenDepth !== 0) return undefined;
  return parts;
}

/** bash/pwsh 是复合命令工具；mcp/web_search 的 command 是名字或自由文本，不按 shell 语义拆。 */
const COMPOUND_COMMAND_TOOLS = new Set(['bash', 'pwsh']);

/**
 * 一条规则是否命中。
 *
 * 语法 `<tool>` 或 `<tool>:<pattern>`，**只按第一个冒号切分**：shell 命令里冒号很常见
 * （`git commit -m "fix: x"`），从右边切会把命令切碎。不写 pattern 就是「这个工具的全部」，
 * 写了就按通配匹配——不带通配符即精确匹配，精确是更安全的默认值。
 */
function ruleMatches(entry: string, request: ApprovalRequest, detail = approvalDetail(request)): boolean {
  const sep = entry.indexOf(':');
  const tool = (sep === -1 ? entry : entry.slice(0, sep)).trim();
  if (tool === '' || tool !== request.tool) return false;
  const pattern = sep === -1 ? '' : entry.slice(sep + 1).trim();
  if (pattern === '') return true;
  return globToRegExp(pattern).test(detail);
}

/**
 * 按 deny > ask > allow 的次序求值；无命中返回 undefined（交回模式与授权集合决定）。
 *
 * 顺序就是优先级，两个参考实现（grok-build、Claude Code）都是这个次序。
 *
 * 复合命令（bash/pwsh）逐段求值（对齐 Claude Code）：deny/ask 命中**任一**子命令
 * 即命中——`npm test && rm -rf /` 里那段 rm 逃不掉；allow 必须覆盖**每一个**子命令，
 * 漏一段就落回模式决定。解析不了的命令（未闭合引号、截断的操作符、未闭合的子 shell）
 * 不允许被 allow 规则放行，fail-closed 交回模式；deny/ask 仍按原文兜底匹配，
 * 能拦一条是一条。mcp/web_search 的 command 不是 shell 语义，保持整串匹配。
 */
export function evaluateRules(
  rules: PermissionRules | undefined,
  request: ApprovalRequest,
): RuleAction | undefined {
  if (!rules) return undefined;
  const denyOrAsk = (detail: string): RuleAction | undefined => {
    if (rules.deny.some((entry) => ruleMatches(entry, request, detail))) return 'deny';
    if (rules.ask.some((entry) => ruleMatches(entry, request, detail))) return 'ask';
    return undefined;
  };

  if (!COMPOUND_COMMAND_TOOLS.has(request.tool) || request.command === undefined) {
    const verdict = denyOrAsk(approvalDetail(request));
    if (verdict) return verdict;
    return rules.allow.some((entry) => ruleMatches(entry, request, approvalDetail(request)))
      ? 'allow'
      : undefined;
  }

  const parts = splitShellCommands(request.command);
  if (parts === undefined) {
    // 解析不了：allow 一律不放行；deny/ask 按原文匹配兜底。
    return denyOrAsk(approvalDetail(request));
  }
  if (parts.length === 0) return undefined;
  for (const part of parts) {
    const verdict = denyOrAsk(part);
    if (verdict) return verdict;
  }
  // allow：每一段都得有规则罩着，漏一段就不算通过。
  if (parts.every((part) => rules.allow.some((entry) => ruleMatches(entry, request, part)))) {
    return 'allow';
  }
  return undefined;
}

/**
 * 「本会话总是允许」的作用域键。
 *
 * 为什么不能拿**工具名**当键：对 `shell` 点一次「总是允许」，等于放行本会话的所有命令，
 * 包括 `rm -rf`。用户以为自己只批准了眼前这一条，实际签出的是整个工具——审批机制最容易
 * 漏的就是这个洞。所以按每个工具真正的危险维度取键：
 *
 * - `bash` / `pwsh`：归一化后的命令原文。换一个参数就是另一个动作，必须重新问。
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
    case 'bash':
    case 'pwsh': {
      const command = (request.command ?? '').trim().replace(/\s+/g, ' ');
      return command === '' ? request.tool : `${request.tool} ${command}`;
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
