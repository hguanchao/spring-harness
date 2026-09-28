export type ApprovalMode = 'ask' | 'auto' | 'yolo';

/** 合法取值清单（配置校验、CLI 校验、命令面板共用一份，避免三处各写一遍）。 */
export const APPROVAL_MODES: readonly ApprovalMode[] = ['ask', 'auto', 'yolo'];

/**
 * 子代理的审批策略。
 *
 * `inherit`：复用父会话的审批器，包括父会话已经批准过的授权——子代理是父会话派出去的
 * 同一件事的延续。`strict`：fail-closed，受审工具一律拒绝、不弹窗、不共享父会话的授权
 * ——后台子代理不该把交互决策传下去，也不该悄悄扩大父会话的授权面。严格档下受审工具直接拒绝。
 */
export const SUBAGENT_APPROVAL_POLICIES = ['inherit', 'strict'] as const;
export type SubagentApprovalPolicy = (typeof SUBAGENT_APPROVAL_POLICIES)[number];

/** 需要审查的工具：ask 模式问人，auto 模式过分类器，yolo 直接放行。 */
export const REVIEWED_TOOLS = new Set(['bash', 'pwsh', 'web_search', 'web_fetch', 'mcp', 'enter_plan_mode']);

/** 走 shell 语义的工具：规则按命令前缀通配、复合命令逐段求值，只读判定也只对它们成立。 */
const SHELL_TOOLS = new Set(['bash', 'pwsh']);

/**
 * 路径型工具：规则里的 specifier 是路径，不是命令。
 *
 * 这些工具默认不弹窗（写权限由沙箱管，见 `sandbox/`），所以它们的规则里只有 **deny 与 ask**
 * 有意义——allow 对它们没有可放行的事。取路径的参数名统一是 `path`，集中在这里而不是散到
 * 六个工具文件里，避免「同一条规则在不同工具上语义不同」。
 */
const PATH_TOOLS = new Set(['read', 'write', 'edit', 'ls', 'glob', 'grep']);

/** 路径型工具取目标的参数名。 */
export const PATH_ARG = 'path';

/** 网络工具：`domain:` 前缀按主机名匹配。 */
const WEB_TOOLS = new Set(['web_fetch', 'web_search']);

/**
 * 可参与参数匹配的参数名（`tool(参数=值)`）。
 *
 * 只列**语义明确、且不会与 shell 的 `KEY=value` 前缀撞车**的参数。`command` / `path` 这类
 * 主内容字段一律不列——它们本来就是 specifier 匹配的对象，允许当参数写只会让一条规则有
 * 两种解释。
 */
const MATCHABLE_PARAMS: Record<string, readonly string[]> = {
  bash: ['background', 'timeout_ms'],
  pwsh: ['background', 'timeout_ms'],
};

export interface ApprovalRequest {
  tool: string;
  /** shell 的命令原文、web 的 url、mcp 的 `server.tool`、escalate 的说明。 */
  command?: string;
  /** 路径型工具的目标路径、escalate 的目标路径。 */
  path?: string;
  /**
   * 目标路径解析后的真实路径（软链解析结果）。调用方在文件存在时补上它，规则层保持纯函数。
   * allow 要求请求路径与真实路径**都**命中，deny/ask 任一命中即算——软链既不能成为绕过
   * deny 的通道，也不能成为 allow 误放行的理由。
   */
  realPath?: string;
  /** 工具调用的原始参数；只有参数匹配规则读它。 */
  args?: Record<string, unknown>;
}

/**
 * 权限规则：`[permissions]` 里的 allow / ask / deny 三张表。
 *
 * 与「模式」的分工——模式（ask/auto/yolo）是**全局的当下态度**，规则是**针对具体
 * 动作的长期意图**。用户写下的规则比一次模式切换更具体，所以优先级更高；deny 尤其如此：
 * 它是「这个绝对不能做」的硬边界，必须连 yolo 都绕不过去。
 *
 * 语法是 `Tool` 或 `Tool(specifier)`，specifier 按工具类别解释：
 *
 *   bash(git log *)        命令前缀通配：`*` 匹配任意文本（含空格），`?` 单字符
 *   bash(npm test:*)       等价写法；`:*` 只在末尾生效
 *   bash(background=true)  参数匹配（只认 MATCHABLE_PARAMS 里列出的参数名）
 *   read(~/secrets/**)     路径：`//` 绝对、`~/` 主目录、`/` 相对配置来源、其余相对工作区
 *   read(*.env)            同上；`!` 前缀是否定（gitignore 语义，只在同一张表内生效）
 *   web_fetch(domain:*.a.com)
 *   mcp(context7)          MCP 的 server；也可写 `context7.resolve-library-id`
 *
 * 工具名位置写 `*` 可以匹配一批工具（如 deny 里的 `mcp*`）；allow 里的工具名必须是字面量。
 */
export type RuleAction = 'allow' | 'ask' | 'deny';

export interface PermissionRules {
  allow: readonly string[];
  ask: readonly string[];
  deny: readonly string[];
}

export const EMPTY_RULES: PermissionRules = Object.freeze({ allow: [], ask: [], deny: [] });

/**
 * 一层规则及其**来源目录**。
 *
 * 来源目录决定 `/path` 锚定到哪儿：用户级配置锚定 `~/.sph`，项目级锚定仓库根。不记住这一点，
 * 同一条 `edit(/src/**)` 在两份配置里会指向不同地方，且无法解释。
 */
export interface RuleSet {
  rules: PermissionRules;
  sourceDir: string;
}

/** 分层规则：项目级叠在用户级之上，而 deny / ask 的优先关系是跨层的（见 evaluateRules）。 */
export interface RuleLayers {
  user?: RuleSet;
  project?: RuleSet;
}

/** 求值需要的环境事实；调用方通常传工作区根与主目录。 */
export interface RuleEnv {
  workspaceRoot: string;
  home: string;
}

// ---------------------------------------------------------------------------
// 解析

interface ParsedRule {
  raw: string;
  action: RuleAction;
  negated: boolean;
  /** 规则来自哪一层（用户级 / 项目级）；路径规则的否定只在本层内生效。 */
  layerKey: string;
  tool: string;
  /** 工具名含 `*` / `?` 时用来匹配工具名。 */
  toolGlob?: RegExp;
  /** 括号里的内容；不带括号即 undefined（= 该工具的全部调用）。 */
  specifier?: string;
}

/** 解析失败即抛错：规则写了却不生效是最坏的结果，宁可启动就失败。 */
export function parseRuleEntry(entry: string, action: RuleAction, layerKey: string, where: string): ParsedRule {
  const raw = entry.trim();
  if (raw === '') throw new Error(`${where}: empty rule`);

  // `Tool` 或 `Tool(specifier)`：从第一个 `(` 切到末尾的 `)`。命令里带括号很常见
  // （`bash(echo (a))` 要整个进 specifier），所以只在末尾是 `)` 时才当 specifier。
  const open = raw.indexOf('(');
  const hasSpecifier = open > 0 && raw.endsWith(')');
  const tool = (hasSpecifier ? raw.slice(0, open) : raw).trim();
  let specifier = hasSpecifier ? raw.slice(open + 1, -1).trim() : undefined;

  // 旧写法 `tool:pattern` 不再支持：两套语法并存会让「哪一条生效」不可预测。
  if (tool.includes(':')) {
    const colon = raw.indexOf(':');
    throw new Error(
      `${where}: "${raw}" uses the removed "tool:pattern" syntax — write "${raw.slice(0, colon)}(...)" instead`,
    );
  }
  if (tool === '') throw new Error(`${where}: "${raw}" has no tool name`);

  let negated = false;
  if (specifier !== undefined && specifier.startsWith('!')) {
    // 否定是 gitignore 语义，只对路径有意义；写在别的类别里是笔误。
    if (!PATH_TOOLS.has(tool)) throw new Error(`${where}: "${raw}" — "!" negation only applies to path rules`);
    negated = true;
    specifier = specifier.slice(1).trim();
    if (specifier === '') throw new Error(`${where}: "${raw}" has an empty negated pattern`);
  }

  const wildcard = tool.includes('*') || tool.includes('?');
  if (wildcard && action === 'allow') {
    throw new Error(`${where}: "${raw}" — allow rules must name a tool literally (no "*" in the tool name)`);
  }
  if (wildcard && specifier !== undefined) {
    throw new Error(`${where}: "${raw}" — a tool-name pattern cannot take a specifier`);
  }

  return {
    raw,
    action,
    negated,
    layerKey,
    tool,
    ...(wildcard ? { toolGlob: globToRegExp(tool) } : {}),
    ...(specifier === undefined || specifier === '' ? {} : { specifier }),
  };
}

/**
 * 编译分层规则。数组顺序就是求值顺序：
 * 先 deny（用户级 → 项目级），再 ask，最后 allow —— 跨层同样是这个次序。
 */
export function compileLayers(layers: RuleLayers): ParsedRule[] {
  const entries: ParsedRule[] = [];
  const sets: Array<[string, RuleSet | undefined]> = [
    ['user', layers.user],
    ['project', layers.project],
  ];
  // deny 全体先来（用户级 → 项目级），再 ask 全体，最后 allow 全体。跨层也是这个次序。
  for (const action of ['deny', 'ask', 'allow'] as const) {
    for (const [key, set] of sets) {
      if (!set) continue;
      for (const raw of set.rules[action]) {
        entries.push(parseRuleEntry(raw, action, key, `${key} permissions.${action}`));
      }
    }
  }
  return entries;
}

/** 编译并带上来源目录；路径规则解析锚定要用它。 */
interface CompiledRule extends ParsedRule {
  sourceDir: string;
}

/**
 * 校验一层规则的语法。写错就抛——**启动即失败**，不留「规则写了却不生效」的静默状态。
 * 配置层传自己的错误类型进来（ConfigError），测试直接用默认的 Error。
 */
export function validateRules(
  rules: PermissionRules,
  where: string,
  makeError: (message: string) => Error = (message) => new Error(message),
): void {
  for (const action of ['deny', 'ask', 'allow'] as const) {
    for (const raw of rules[action]) {
      try {
        parseRuleEntry(raw, action, 'user', `${where}.${action}`);
      } catch (error) {
        throw makeError(error instanceof Error ? error.message : String(error));
      }
    }
  }
}

/** 这个工具是不是路径型（规则按路径解释、且默认不弹窗）。 */
export function isPathTool(tool: string): boolean {
  return PATH_TOOLS.has(tool);
}

function compiledRules(layers: RuleLayers): CompiledRule[] {
  const dirs = new Map<string, string>([
    ['user', layers.user?.sourceDir ?? ''],
    ['project', layers.project?.sourceDir ?? ''],
  ]);
  return compileLayers(layers).map((entry) => ({ ...entry, sourceDir: dirs.get(entry.layerKey) ?? '' }));
}

// ---------------------------------------------------------------------------
// 通配符与包装器

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
 * 剥离命令前缀里那些「不影响它到底做什么」的包装器，再交给规则比对。
 *
 * 不剥的话 `bash(npm test *)` 命中不了 `timeout 30 npm test`，而那正是日常最常写的形态；
 * 对 deny 只会更严（`timeout 30 rm -rf /` 反而能被 `bash(rm *)` 抓住）。
 *
 * 剥的是：`timeout`（连它自己的时长参数）、`time`、`nice`、`nohup`、`stdbuf`、`command`、
 * `builtin`、`noglob`，以及 `KEY=value` 形态的环境变量赋值前缀。
 * **不剥** `npx` / `docker exec` / `direnv` 这类真的会换程序的包装器——剥了等于放行别的程序。
 */
export function stripCommandWrappers(segment: string): string {
  let rest = segment.trim().replace(/\s+/g, ' ');
  for (let guard = 0; guard < 8; guard += 1) {
    const before = rest;
    rest = rest.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, '');
    const head = /^(\S+)/.exec(rest)?.[1] ?? '';
    const tail = rest.slice(head.length).trim();
    const words = tail === '' ? [] : tail.split(' ');

    if (head === 'timeout') {
      const drop = words[0] !== undefined && /^[0-9]+(\.[0-9]+)?[smhd]?$/.test(words[0]) ? 1 : 0;
      rest = words.slice(drop).join(' ');
      continue;
    }
    if (head === 'nice') {
      // `-n 5` 带值，一并剥掉；其余只剥 flag。
      const drop = words[0] === '-n' ? 2 : words.filter((word) => word.startsWith('-')).length;
      rest = words.slice(drop).join(' ');
      continue;
    }
    if (head === 'stdbuf') {
      rest = words.slice(words.filter((word) => word.startsWith('-')).length).join(' ');
      continue;
    }
    if (['time', 'nohup', 'command', 'builtin', 'noglob'].includes(head)) {
      // 这几个自己的 flag 少见；遇到 `-` 开头的参数就停手，别把真实命令一起吃掉。
      if (tail.startsWith('-')) break;
      rest = tail;
      continue;
    }
    if (before === rest) break;
  }
  return rest;
}

/** 命令模式匹配：整体通配，且「末尾 ` *`」也匹配裸命令（`ls *` 匹配 `ls`）。 */
export function matchCommandPattern(pattern: string, segment: string): boolean {
  let text = pattern.trim();
  if (text.endsWith(':*')) text = `${text.slice(0, -2)} *`; // `:*` 只在末尾是通配符
  if (text === '' || text === '*') return true;
  const candidates = [segment, stripCommandWrappers(segment)];
  const full = globToRegExp(text);
  const headOnly = text.endsWith(' *') ? globToRegExp(text.slice(0, -2)) : undefined;
  return candidates.some((candidate) => full.test(candidate) || headOnly?.test(candidate) === true);
}

// ---------------------------------------------------------------------------
// 路径规则

/** gitignore 风格：`**` 跨任意层（后跟斜杠时连斜杠一起吞）、`*` 不跨斜杠、`?` 单字符。 */
function pathGlobToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**` 后跟斜杠时连斜杠一起吞，这样 `**` 前缀的规则也能匹配顶层的同名目录。
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** Windows 与 macOS 的默认文件系统不区分大小写；规则比较跟着平台走。 */
function foldCase(path: string): string {
  return process.platform === 'linux' ? path : path.toLowerCase();
}

function toPosix(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/');
}

/**
 * `//C:/...` 去掉标记斜杠后仍以 `/` 开头。Windows 的请求路径是 `C:/...`，
 * 两边不在同一套写法上就永远匹配不上，所以盘符前的那个斜杠要拿掉。
 */
function normalizeAbsolute(posix: string): string {
  return posix.replace(/^\/+([A-Za-z]:)/, '$1');
}

/** 把规则里的路径 pattern 解析成绝对路径。锚定检测必须赶在斜杠归一之前——`//` 是标记。 */
function resolvePathPattern(pattern: string, sourceDir: string, env: RuleEnv): string {
  const posix = pattern.replace(/\\/g, '/');
  const abs = posix.startsWith('//')
    ? normalizeAbsolute(posix.slice(1)) // `//` 是「后面跟的是文件系统绝对路径」的标记
    : posix.startsWith('~/')
      ? `${toPosix(env.home)}/${posix.slice(2)}`
      : posix.startsWith('/')
        ? `${toPosix(sourceDir)}${posix}`
        : `${toPosix(env.workspaceRoot)}/${posix.replace(/^\.\//, '')}`;
  return foldCase(normalizeAbsolute(abs).replace(/\/{2,}/g, '/'));
}

function pathTargetOf(request: ApprovalRequest, env: RuleEnv): { abs: string; real?: string } | undefined {
  const raw = request.path?.trim();
  if (raw === undefined || raw === '') return undefined;
  const posix = normalizeAbsolute(toPosix(raw));
  const abs = posix.startsWith('/') || /^[A-Za-z]:\//.test(posix)
    ? posix
    : `${toPosix(env.workspaceRoot)}/${posix.replace(/^\.\//, '')}`;
  const real = request.realPath === undefined ? undefined : normalizeAbsolute(toPosix(request.realPath));
  return { abs: foldCase(abs), ...(real === undefined ? {} : { real: foldCase(real) }) };
}

/**
 * allow 要求目标路径与真实路径都命中；deny/ask 任一命中即算。没给真实路径就只看请求路径。
 *
 * 另一条关键差异（与 CC 一致）：**相对模式**（不带 `//`、`~/`、`/` 锚定）在 deny/ask 里按
 * 「任意深度」解释——`Read(*.env)` 要能拦住任意层下的 .env，`Read(secrets/**)` 要能拦住
 * 任意层下的 secrets 目录；而 allow 只锚定工作区，不给 allow 凭空扩大范围的口子。
 */
function matchPathPattern(
  pattern: string,
  target: { abs: string; real?: string },
  sourceDir: string,
  env: RuleEnv,
  requireAll: boolean,
): boolean {
  const re = pathGlobToRegExp(resolvePathPattern(pattern, sourceDir, env));
  const candidates = target.real === undefined ? [target.abs] : [target.abs, target.real];
  const hits = candidates.map(re.test.bind(re));
  if (requireAll) return hits.every(Boolean);
  if (hits.some(Boolean)) return true;
  const posix = toPosix(pattern);
  const relativeBare = !posix.startsWith('//') && !posix.startsWith('~/') && !posix.startsWith('/');
  if (!relativeBare) return false;
  const anywhere = pathGlobToRegExp(foldCase(posix.replace(/^\.\//, '')));
  return candidates.some((candidate) =>
    suffixPaths(candidate).some((suffix) => anywhere.test(suffix)),
  );
}

/** 目标路径的每个「段边界」后缀：`/ws/a/.env` → ['a/.env', '.env']（含自身）。 */
function suffixPaths(abs: string): string[] {
  const parts = abs.split('/').filter((part) => part !== '');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 1) out.push(parts.slice(i).join('/'));
  return out;
}

// ---------------------------------------------------------------------------
// 匹配

/** `domain:` 匹配主机名：`*.a.com` 匹配子域但不匹配 `a.com` 本身。 */
function matchDomain(pattern: string, rawUrl: string): boolean {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return false;
  }
  const want = pattern.slice('domain:'.length).trim().toLowerCase().replace(/\.$/, '');
  if (want === '*') return true;
  if (want.startsWith('*.')) return host.endsWith(want.slice(1)) && host !== want.slice(2);
  return host === want;
}

/** 一条规则是否命中这次调用。`allow` 传 true 时会额外要求真实路径也命中。 */
function ruleHits(entry: CompiledRule, request: ApprovalRequest, env: RuleEnv, requireAll = false): boolean {
  if (entry.toolGlob !== undefined) return entry.toolGlob.test(request.tool);
  if (entry.tool !== request.tool) return false;
  if (entry.specifier === undefined) return true;

  if (SHELL_TOOLS.has(request.tool)) {
    const params = MATCHABLE_PARAMS[request.tool] ?? [];
    const eq = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(entry.specifier);
    if (eq !== null && params.includes(eq[1]!)) return String(request.args?.[eq[1]!]) === eq[2];
    return matchCommandPattern(entry.specifier, request.command ?? '');
  }
  if (PATH_TOOLS.has(request.tool)) {
    const target = pathTargetOf(request, env);
    if (target === undefined) return false;
    return matchPathPattern(entry.specifier, target, entry.sourceDir, env, requireAll);
  }
  if (WEB_TOOLS.has(request.tool) && entry.specifier.startsWith('domain:')) {
    return matchDomain(entry.specifier, request.command ?? '');
  }
  if (request.tool === 'mcp') {
    // `server` / `server.tool` / `server/*` 都归一成 `server.tool` 再比。
    const want = entry.specifier.replace('/', '.');
    const detail = request.command ?? '';
    return detail === want || detail.startsWith(`${want}.`) || globToRegExp(want).test(detail);
  }
  return globToRegExp(entry.specifier).test(approvalDetail(request));
}

/** 规则 pattern 的匹配对象：与 approvalScopeKey 同一份细节，两处口径必须一致。 */
function approvalDetail(request: ApprovalRequest): string {
  return (request.command ?? request.path ?? '').trim().replace(/\s+/g, ' ');
}

/**
 * 按 deny > ask > allow 的次序求值；无命中返回 undefined（交回模式与授权集合决定）。
 *
 * **跨层也是这个次序**：任一层的 deny 都先于所有 allow 求值，项目级 deny 压得住用户级
 * allow，反过来也一样。项目级 allow 是否参与由调用方决定（未信任的工作区不装载它）。
 *
 * 复合命令（bash/pwsh）逐段求值：deny/ask 命中**任一**子命令即命中——`npm test && rm -rf /`
 * 里那段 rm 逃不掉；allow 必须覆盖**每一个**子命令，漏一段就落回模式决定。解析不了的命令
 * （未闭合引号、截断的操作符、未闭合的子 shell）不允许被 allow 放行，fail-closed 交回模式；
 * deny/ask 仍按原文兜底匹配，能拦一条是一条。段内还有打不开的命令替换时同样不给 allow。
 *
 * 路径规则的 `!` 否定的作用域是**它自己那一张表**：项目级的否定项不可能解除用户级的 deny。
 */
export function evaluateRules(
  layers: RuleLayers,
  request: ApprovalRequest,
  env: RuleEnv = { workspaceRoot: process.cwd(), home: '' },
): RuleAction | undefined {
  const entries = compiledRules(layers);
  if (entries.length === 0) return undefined;

  if (!SHELL_TOOLS.has(request.tool) || request.command === undefined) {
    return verdictOf(entries, request, env);
  }

  const parts = splitShellCommands(request.command);
  if (parts === undefined) {
    // 解析不了：allow 一律不放行（命令里可能藏着看不见的部分）；deny/ask 仍按原文兜底匹配。
    return verdictOf(entries, request, env, { allow: false });
  }
  if (parts.length === 0) return undefined;
  for (const part of parts) {
    const hit = verdictOf(entries, { ...request, command: part }, env);
    if (hit === 'deny' || hit === 'ask') return hit;
  }
  // allow：每一段都得被罩住，漏一段就不算通过。段内还有打不开的替换时不给 allow。
  const shell = request.tool === 'pwsh' ? 'pwsh' : 'bash';
  if (parts.some((part) => hidesCommandSubstitution(part, shell))) return undefined;
  const everySegmentAllowed = parts.every((part) =>
    entries.some(
      (entry) => entry.action === 'allow' && ruleHits(entry, { ...request, command: part }, env),
    ),
  );
  return everySegmentAllowed ? 'allow' : undefined;
}

/**
 * 单次调用的线性求值。
 *
 * 路径规则的否定是 gitignore 的 last-match-wins，但**只在同一张表内**：按 (动作, 层) 分组
 * 各自记最后一次命中的结果，最后再按 deny > ask > allow 出结论。
 */
function verdictOf(
  entries: readonly CompiledRule[],
  request: ApprovalRequest,
  env: RuleEnv,
  options: { allow?: boolean } = {},
): RuleAction | undefined {
  const flat = new Set<RuleAction>();
  const perTable = new Map<string, { action: RuleAction; hit: boolean }>();

  for (const entry of entries) {
    // 解析不了的命令不给 allow：命令里可能藏着拆分器看不见的部分（见 evaluateRules）。
    if (entry.action === 'allow' && options.allow === false) continue;
    if (entry.toolGlob !== undefined) {
      if (entry.toolGlob.test(request.tool)) flat.add(entry.action);
      continue;
    }
    if (entry.tool !== request.tool) continue;
    if (PATH_TOOLS.has(request.tool) && entry.negated) {
      // 否定项要能盖住同表里之前的命中（`Read(*.env)` + `Read(!sample.env)`）。
      // specifier 在解析时已经去掉 `!`，所以 ruleHits 直接判就是「这个 pattern 命中了吗」。
      if (ruleHits(entry, request, env)) {
        perTable.set(`${entry.layerKey}|${entry.action}`, { action: entry.action, hit: false });
      }
      continue;
    }
    if (!ruleHits(entry, request, env, entry.action === 'allow')) continue;
    if (PATH_TOOLS.has(request.tool)) perTable.set(`${entry.layerKey}|${entry.action}`, { action: entry.action, hit: true });
    else flat.add(entry.action);
  }
  for (const { action, hit } of perTable.values()) if (hit) flat.add(action);
  if (flat.has('deny')) return 'deny';
  if (flat.has('ask')) return 'ask';
  if (flat.has('allow')) return 'allow';
  return undefined;
}

/**
 * 为「总是允许」提议一条**可复用**的规则。
 *
 * 只批准眼前这一条命令的话，下一个参数换一下又要问一遍。所以从这个动作里提炼一条规则：
 * 取命令的「程序 + 子命令」两段做前缀（`npm run *`、`git log *`），够窄又不至于每次都问。
 *
 * 三条硬约束（宁可这次不给提议，也不写出一条过宽的规则）：
 *   - 破坏性命令（`rm` / `dd` / `mkfs` / `shutdown` 等）一律不提议；
 *   - 命令里含 heredoc、命令替换、或不是单段（`a && b`）时不提议——这条规则要覆盖什么并不清楚；
 *   - 认不出程序名时不提议。
 *
 * 非 shell 工具用它的动作细节直接建规则（`mcp(context7)`）。
 */
export function suggestAllowRule(request: ApprovalRequest): string | undefined {
  if (!SHELL_TOOLS.has(request.tool)) {
    const detail = (request.command ?? request.path ?? '').trim();
    if (detail === '') return undefined;
    // MCP 的 server 名就是它最自然的规则粒度。
    if (request.tool === 'mcp') return `mcp(${detail.split('.')[0] ?? detail})`;
    return undefined;
  }

  const raw = (request.command ?? '').trim();
  if (raw === '') return undefined;
  if (raw.includes('<<') || raw.includes('`') || raw.includes('$(')) return undefined;
  const parts = splitShellCommands(raw);
  if (parts === undefined || parts.length !== 1) return undefined;

  const words = stripCommandWrappers(parts[0]!).split(' ').filter((word) => word !== '');
  const head = words[0] ?? '';
  if (head === '' || DESTRUCTIVE_COMMANDS.has(head)) return undefined;
  const prefix = words.slice(0, 2).join(' ');
  return `${request.tool}(${prefix} *)`;
}

/** 永不提议规则的程序名：它们的「同类调用」不该被一次性放行。 */
const DESTRUCTIVE_COMMANDS = new Set([
  'rm', 'rmdir', 'del', 'erase', 'format', 'mkfs', 'dd', 'shred', 'truncate',
  'shutdown', 'reboot', 'taskkill', 'kill', 'pkill', 'chmod', 'chown', 'attrib',
]);

/**
 * deny 里被点名（裸工具名或工具名 glob）的工具。
 *
 * 这是「工具直接从上下文里消失」的语义：模型看不到它，也就不会去试。带 specifier 的 deny
 * 不在此列——那种只拒绝具体调用，工具本身仍然可用。
 */
export function deniedToolNames(layers: RuleLayers, candidates: readonly string[]): Set<string> {
  const denied = new Set<string>();
  for (const entry of compileLayers(layers)) {
    if (entry.action !== 'deny' || entry.specifier !== undefined) continue;
    if (entry.toolGlob === undefined) denied.add(entry.tool);
    else for (const name of candidates) if (entry.toolGlob.test(name)) denied.add(name);
  }
  return denied;
}

/**
 * 从一个工具集合里摘掉被 deny 点名的工具。
 *
 * 这是「工具直接从上下文里消失」的语义：模型看不到它，也就不会去试——比让它反复撞在
 * 「denied by a policy」上省 tokens。带 specifier 的 deny 不在此列：那种只拒绝具体调用，
 * 工具本身仍然可用。
 */
export function visibleTools(layers: RuleLayers, names: ReadonlySet<string>): Set<string> {
  const kept = new Set(names);
  for (const name of deniedToolNames(layers, [...names])) kept.delete(name);
  return kept;
}

// ---------------------------------------------------------------------------
// 只读命令

/**
 * 只读命令集合：命中即免审批（**所有模式**下），要拦就写 ask / deny 规则。
 *
 * 逐段判定，且**要求每一段都只读**才算——`cd x && rm -rf y` 里的 rm 会让整条落回审批。
 * 带重定向或 `tee` 的段一律不算只读：那是在写盘，命令行上看不出来。
 *
 * 这张表刻意取窄：认不出来就走审批，宁可多问一次。
 */
const READ_ONLY_COMMANDS = new Set([
  'ls', 'dir', 'pwd', 'cd', 'echo', 'cat', 'type', 'head', 'tail', 'wc', 'stat', 'du', 'df',
  'which', 'where', 'whoami', 'hostname', 'date', 'basename', 'dirname', 'realpath', 'readlink',
  'grep', 'rg', 'diff', 'sort', 'uniq', 'cut', 'tr', 'tree', 'file', 'sed', 'awk', 'jq', 'env',
  'printenv',
]);

/** 只读 git 子命令；带写语义的一律不在表里。 */
const READ_ONLY_GIT = new Set(['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files', 'blame', 'describe']);

/** PowerShell 只读动词前缀（cmdlet 形如 `Get-ChildItem`）。 */
const READ_ONLY_PWSH_VERB = /^(get|test|select|measure|compare|resolve|sort|group|where|out-string|write-output|write-host)-/i;

/** sed / awk / jq 的就地改写开关不算只读。 */
function writesInPlace(words: readonly string[]): boolean {
  return words.some((word) => /^-i/.test(word) || word === '--in-place' || word === '-in-place');
}

/** find 的写/执行开关。 */
function findWrites(words: readonly string[]): boolean {
  return words.some((word) =>
    ['-exec', '-execdir', '-delete', '-ok', '-okdir', '-fprint', '-fwrite'].includes(word),
  );
}

/** 单段命令是否只读。 */
export function isReadOnlySegment(segment: string): boolean {
  const text = stripCommandWrappers(segment);
  if (text === '') return false;
  // 重定向与引号里的命令替换都算写；判定在 hidesCommandSubstitution 之后。
  if (segmentWrites(segment, 'bash') || segmentWrites(text, 'bash')) return false;
  const words = text.split(' ').filter((word) => word !== '');
  const head = words[0] ?? '';
  if (head === '') return false;
  const args = words.slice(1);

  if (head === 'git') {
    const sub = args[0] ?? '';
    if (!READ_ONLY_GIT.has(sub)) return false;
    // `branch -d/-D/-m` 会改状态，不算只读。
    if (sub === 'branch' && args.some((word) => /^(-d|-D|-m|-M|--delete|--move)/.test(word))) return false;
    return true;
  }
  if (head === 'find') return !findWrites(args);
  if (['sed', 'awk', 'jq', 'sort', 'uniq'].includes(head) && writesInPlace(args)) return false;
  if (READ_ONLY_COMMANDS.has(head)) return true;
  return READ_ONLY_PWSH_VERB.test(head);
}

/** 整条命令是否只读：每一段都得是。解析不出来一律 false（fail-closed 走审批）。 */
export function isReadOnlyCommand(command: string): boolean {
  const parts = splitShellCommands(command);
  if (parts === undefined || parts.length === 0) return false;
  return parts.every(isReadOnlySegment);
}

// ---------------------------------------------------------------------------
// 命令拆分

/**
 * 按顶层分隔符把复合命令拆成子命令，规则逐段匹配。管道和逻辑连接符不能靠一条放行把后半段也放过去。
 *
 * 识别的分隔符：`&&`、`||`、`;`、`|`、`|&`、`&`、换行。引号内与反斜杠转义的
 * 分隔符不是切点（`echo "a && b"` 是一条命令）；`2>&1` 里的 `&` 是文件描述符
 * 复制（跟在 `>`/`<` 后），不切；`(`、`)` 是子 shell 边界，也作为切点——
 * 里面的命令同样要被 deny 看见、被 allow 覆盖。
 *
 * 返回 undefined 表示解析不了：未闭合引号、截断的操作符（`npm test &&`）、
 * 连续分隔符（`a ;; b`）。解析不了的命令绝不能被 allow 规则静默放行。
 *
 * 引号里的 `$(...)` 和 bash 反引号这里看不见（引号不是切点）。那部分不交给 allow，
 * 见 hidesCommandSubstitution。
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

/**
 * 这一段里还有拆分器打不开的命令替换。
 *
 * 双引号里的 `$(...)` bash 与 pwsh 都会执行；bash 反引号在单引号外也会执行。
 * 它们都不是切点，所以 `echo "$(rm -rf /)"` 整段仍像 echo，allow 的前缀 glob 会放行。
 * 单引号内不执行。未加引号的 `$(...)` 已经被括号切点拆开，不在这里重复拦截。
 * pwsh 的反引号是转义，不是替换。
 *
 * 这只撤掉 allow。yolo 下一条 `rm*` 的 deny 仍然匹配不到引号里面——那要完整 shell 解析。
 */
function hidesCommandSubstitution(segment: string, tool: 'bash' | 'pwsh'): boolean {
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]!;
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      continue;
    }
    // 与 splitShellCommands 同一套反斜杠：被转义的 $ / ` 不是替换。
    if (ch === '\\' && i + 1 < segment.length) {
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = undefined;
        continue;
      }
      if (ch === '$' && segment[i + 1] === '(') return true;
      if (tool === 'bash' && ch === '`') return true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (tool === 'bash' && ch === '`') return true;
  }
  return false;
}

/**
 * 这一段是不是在写盘。
 *
 * `2>&1` 只是把一个描述符指到另一个，单独出现不算写。它和真正的重定向写在同一段里时
 * （`cat a > out 2>&1`）仍算写——整段里「有没有一次描述符复制」不能把前面的写盘一起赦免。
 * 引号里的 `$(...)` 也会执行，看起来像 `echo` 的段一样不能当只读。
 */
function segmentWrites(segment: string, shell: 'bash' | 'pwsh'): boolean {
  if (hidesCommandSubstitution(segment, shell)) return true;
  const stripped = segment
    .replace(/(^|\s)\d*>&[0-9-]+/g, ' ')
    .replace(/(^|\s)[0-9]*<&[0-9-]+/g, ' ');
  if (/(^|\s)\d*>>?\s*\S/.test(stripped)) return true;
  if (/(^|\s)tee(\s|$)/.test(stripped)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// 授权键与审批器

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

/** 审批器需要的运行期事实（模式与沙箱档位会变，所以沙箱那两项取函数）。 */
export interface ApproverEnv {
  layers?: RuleLayers;
  /** 路径规则的锚定环境；省略按进程默认。 */
  ruleEnv?: RuleEnv;
  /** 省略按 `off`：不做沙箱免问。 */
  sandboxMode?: () => 'off' | 'workspace' | 'read-only';
  /**
   * 沙箱内免问。默认 false：sph 的沙箱是同主机文件策略、Windows 还只有部分强制，
   * 拿它兜底比进程隔离弱得多，所以由用户显式开启（`sandbox_auto_allow`）。
   */
  sandboxAutoAllow?: () => boolean;
}

export class HeadlessApprover implements Approver {
  constructor(
    private readonly mode: ApprovalMode,
    private readonly classifier?: (request: ApprovalRequest) => Promise<{ allowed: boolean }>,
    private readonly env: ApproverEnv = {},
  ) {}

  async decide(request: ApprovalRequest): Promise<boolean> {
    const rule = evaluateRules(this.env.layers ?? {}, request, this.env.ruleEnv);
    // deny 优先于一切：硬边界，连 yolo 也不该绕过去。
    if (rule === 'deny') return false;
    // headless 无人可问：ask 规则与「受审工具」同归拒绝，不静默放行。
    if (rule === 'ask') return false;
    if (rule === 'allow') return true;
    if (request.tool === 'escalate' || request.tool === 'ask_user') return false;
    if (!REVIEWED_TOOLS.has(request.tool)) return true;
    if (SHELL_TOOLS.has(request.tool) && request.command !== undefined && isReadOnlyCommand(request.command)) return true;
    if (sandboxCovers(request, this.env)) return true;
    if (this.mode === 'yolo') return true;
    if (this.mode === 'auto') {
      if (!this.classifier) return false;
      return (await this.classifier(request)).allowed;
    }
    return false;
  }

  async ask(): Promise<string> {
    return '';
  }
}

/** 沙箱兜得住就不问：只对 shell 有意义，别的工具不由沙箱执行。 */
export function sandboxCovers(request: ApprovalRequest, env: ApproverEnv): boolean {
  if (!SHELL_TOOLS.has(request.tool)) return false;
  if (env.sandboxAutoAllow?.() !== true) return false;
  return (env.sandboxMode?.() ?? 'off') !== 'off';
}

/** 沙箱是否覆盖这条命令；交互式审批器与 headless 共用同一判定。 */
export function isShellTool(tool: string): boolean {
  return SHELL_TOOLS.has(tool);
}
