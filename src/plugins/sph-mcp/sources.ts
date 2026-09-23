/**
 * MCP server 的多来源发现。
 *
 * sph 自己的配置是 `[mcp_servers.<name>]`。外部编辑器里已经配好的 server 也要能被读到，
 * 否则「抄漏一个字段」导致的静默失败最难查。
 * 这里把同一台机器上其他 agent 的配置读进来，按工具优先级合并。
 *
 * 三条设计约束：
 *
 * 1. **外部文件只读。** 别人的配置文件一概不写。启停状态存在 sph
 *    自己的配置里（`[mcp] disabled_servers`）——写别人的配置会带来意料之外的副作用，
 *    而「读了却不改」也让整个发现过程可随时撤销。
 * 2. **坏条目降级为警告，不炸启动。** 外部来源尤其如此：别人的配置文件格式演进不该让
 *    sph 起不来。只有 sph 自己的用户级配置仍走 `config/load.ts` 的严格校验。
 * 3. **发现 ≠ 已连上。** 坏 URL、未知 transport、被禁用的条目都会出现在结果里并被如实标注。把
 *    「我配了却不生效」变成一条能看见的原因，比读的时候静默跳过它有用得多。
 *
 * 优先级（低 → 高，同名整条替换、不做字段合并）：
 *
 *   `.mcp.json`  <  用户级外部配置  <  项目级外部配置  <  sph 自身
 *
 * 每个工具内部则是「项目级 > 用户级」：仓库里的声明比全局声明更贴近当下这次工作。
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { McpOrigin } from './hub.js';
import { normalizeTransport } from './transport.js';
import type { PluginHostFacts } from '../types.js';

/**
 * `error instanceof Error ? message : String(error)`。本地三行，不值得为它撑大宿主 api 面。
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type McpSourceKind =
  | 'sph'
  | 'sph-project'
  | 'claude'
  | 'claude-project'
  | 'codex'
  | 'codex-project'
  | 'mcp-json';

const PROJECT_SCOPED: ReadonlySet<McpSourceKind> = new Set<McpSourceKind>([
  'sph-project',
  'claude-project',
  'codex-project',
  'mcp-json',
]);

/** 已发现的一个 server 定义。 */
export interface DiscoveredMcpServer {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  /** 来源里的 `transport` 或 `type`，已经归一成 stdio / http / sse。 */
  transport?: 'stdio' | 'http' | 'sse';
  headers?: Record<string, string>;
  /** 表内 `name`。与表头 ID 相同时不记。 */
  title?: string;
  /** **来源声明**的启用态（叠加本地偏好之前）。 */
  sourceEnabled: boolean;
  /** 叠加本地偏好之后最终生效的启用态。 */
  enabled: boolean;
  /** 来自 `[mcp] lazy_servers` 偏好：首次使用才连接。 */
  lazy: boolean;
  kind: McpSourceKind;
  /** 项目级来源落地的工作区根；用户级为 undefined。 */
  projectRoot?: string;
  origin: McpOrigin;
}

/**
 * 某个候选文件被读取的结果。
 *
 * 只为「我明明配了却看不到」服务：没读到也要说清是文件不存在、被导入标记跳过、还是
 * 解析失败——否则用户唯一能做的就是猜。
 */
export interface McpSourceReport {
  label: string;
  path: string;
  status: 'found' | 'empty' | 'missing' | 'skipped' | 'invalid';
  count: number;
  detail?: string;
}

export interface McpDiscovery {
  servers: DiscoveredMcpServer[];
  reports: McpSourceReport[];
  warnings: string[];
}

/** 本地启停偏好：写在 sph 用户级配置的 `[mcp]` 段里，叠加在来源的 enabled 之上。 */
export interface McpPreferences {
  disabledServers: string[];
  enabledServers: string[];
  /** 首次使用才连接的 server（如重型的 npx server）；对任意来源生效，默认全部立即连。 */
  lazyServers: string[];
}

export interface DiscoverOptions {
  workspaceRoot: string;
  /** 宿主事实与策略。路径规范化、状态目录、信任判定都取自它，插件不自带一份。 */
  host: PluginHostFacts;
  /** 项目级查找的起点，向上走到 `workspaceRoot`（含）。省略即从 `workspaceRoot` 开始。 */
  fromDir?: string;
  /** sph 用户级状态目录，省略取宿主事实里的 `sphHome`。 */
  sphHomeDir?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** 工作区是否已信任。省略查 config.toml；false 时项目级来源一律丢弃。 */
  trusted?: boolean;
  /** 本地启停偏好，取自 sph 用户级配置。 */
  preferences?: McpPreferences;
}

export function discoverMcpServers(options: DiscoverOptions): McpDiscovery {
  const workspaceRoot = options.host.canonicalize(options.workspaceRoot);
  const fromDir = resolve(options.fromDir ?? options.workspaceRoot);
  const sphHomeDir = options.sphHomeDir ?? options.host.sphHome;
  // 注意别把 `home` 回退成 sphHomeDir(=~/.sph)：那会让所有外部来源都去找
  // `~/.sph/.claude.json` 这种不存在的路径，表现为「一个 server 都扫不到」。
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const trusted = options.trusted ?? options.host.isWorkspaceTrusted(options.workspaceRoot);
  const preferences = options.preferences ?? { disabledServers: [], enabledServers: [], lazyServers: [] };

  const reports: McpSourceReport[] = [];
  const warnings: string[] = [];
  // 低优先级先进，高优先级覆盖：`set` 覆盖语义天然实现「同名高者胜」。
  const merged = new Map<string, MergedServer>();
  /** 项目级来源声明过的**全部**名字，含输给高优先级的那些。信任门按它过滤。 */
  const projectDeclared = new Set<string>();

  const chain = chainDirs(workspaceRoot, fromDir, options.host);
  const projectBlocked = !trusted;

  const put = (spec: MergedServer): void => {
    if (PROJECT_SCOPED.has(spec.kind)) projectDeclared.add(spec.name);
    // 未信任的工作区：项目级来源整个不参与合并。
    if (projectBlocked && PROJECT_SCOPED.has(spec.kind)) return;
    merged.set(spec.name, spec);
  };

  // ── 1. `.mcp.json`：MCP 标准格式，仓库根 → cwd，最近的赢 ────────────────────
  readLayer({
    label: '.mcp.json',
    paths: chain.map((dir) => join(dir, '.mcp.json')),
    reports,
    warnings,
    read: (path, text) => jsonMcpServers(text, path, warnings),
    toSpec: (name, entry, path) => ({
      ...entry,
      name,
      kind: 'mcp-json',
      projectRoot: workspaceRoot,
      origin: originOf('.mcp.json', path, false),
    }),
    put,
  });

  // ── 2. 用户主目录与项目里的外部 TOML：用户级 → 项目级 ─────────────────────
  readLayer({
    label: '~/.codex/config.toml',
    paths: [join(home, '.codex', 'config.toml')],
    reports,
    warnings,
    read: (path, text) => tomlMcpTable(text, path, warnings, env),
    toSpec: (name, entry, path) => ({
      ...entry,
      name,
      kind: 'codex',
      origin: originOf('~/.codex/config.toml', path, false),
    }),
    put,
  });
  readLayer({
    label: '<项目>/.codex/config.toml',
    paths: chain.map((dir) => join(dir, '.codex', 'config.toml')),
    reports,
    warnings,
    read: (path, text) => tomlMcpTable(text, path, warnings, env),
    toSpec: (name, entry, path) => ({
      ...entry,
      name,
      kind: 'codex-project',
      projectRoot: workspaceRoot,
      origin: originOf('.codex/config.toml', path, false),
    }),
    put,
  });

  // ── 3. 用户主目录 JSON：顶层 mcpServers 与按目录分的 projects 段 ──────────
  readLayer({
    label: '~/.claude.json',
    paths: [join(home, '.claude.json')],
    reports,
    warnings,
    read: (path, text) => jsonMcpServers(text, path, warnings),
    toSpec: (name, entry, path) => ({
      ...entry,
      name,
      kind: 'claude',
      origin: originOf('~/.claude.json', path, false),
    }),
    put,
  });
  readLayer({
    label: '~/.claude.json projects',
    paths: [join(home, '.claude.json')],
    reports,
    warnings,
    read: (path, text) => jsonMcpServers(text, path, warnings, { claudeProject: chain }),
    toSpec: (name, entry, path) => ({
      ...entry,
      name,
      kind: 'claude-project',
      projectRoot: workspaceRoot,
      origin: originOf('~/.claude.json projects.<cwd>', path, false),
    }),
    put,
  });

  // ── 4. sph 自身：用户级 → 项目级，永远最高优先级 ─────────────────────────
  readLayer({
    label: '~/.sph/config.toml',
    paths: [join(sphHomeDir, 'config.toml')],
    reports,
    warnings,
    read: (path, text) => tomlMcpTable(text, path, warnings, env),
    toSpec: (name, entry, path) => ({
      ...entry,
      name,
      kind: 'sph',
      origin: originOf('~/.sph/config.toml', path, true),
    }),
    put,
  });
  readLayer({
    label: '<项目>/.sph/config.toml',
    paths: chain.map((dir) => join(dir, '.sph', 'config.toml')),
    reports,
    warnings,
    read: (path, text) => tomlMcpTable(text, path, warnings, env),
    toSpec: (name, entry, path) => ({
      ...entry,
      name,
      kind: 'sph-project',
      projectRoot: workspaceRoot,
      origin: originOf('.sph/config.toml', path, true),
    }),
    put,
  });

  // ── 5. 信任门：未信任时，项目声明过的名字一律丢弃（含更高优先级的同名条目）──
  //
  // 为什么不只丢「项目那一份」：合并之后只剩一个同名条目，但名字是唯一的身份——用户的
  // 全局条目一旦被移除或被改名，项目的版本会**静默**接管这个名字。未信任的仓库不得影响
  // 这个名字最终 spawn 出什么命令，所以整名丢弃。
  //
  // 当前 bootstrap 在未信任时会直接拒绝启动，所以这条在正常流程下不会触发；把它留在
  // 纯函数里，是为了让「发现」这一步自身 fail-closed，而不是依赖调用方已经 gate 过。
  if (projectBlocked && projectDeclared.size > 0) {
    for (const name of projectDeclared) merged.delete(name);
    warnings.push(
      `workspace is not trusted: dropped ${projectDeclared.size} MCP server(s) declared by project-scoped configs`,
    );
  }

  // ── 6. 本地启停偏好：最后叠加，能覆盖任何来源的 enabled ─────────────────
  //
  // 两个字段都要留下：`sourceEnabled` 是来源自己声明的，`enabled` 是最终生效的。
  // 弹窗里切换开关时要知道「关掉它」是写进 disabled_servers 还是 enabled_servers——
  // 只留一个最终值就只能猜，猜错就会在另一个列表里留下一条过期的强制项。
  // lazy 同理来自本地偏好：外部来源没有这个概念，只能由 sph 自己记。
  const disabled = new Set(preferences.disabledServers);
  const enabled = new Set(preferences.enabledServers);
  const lazy = new Set(preferences.lazyServers);
  const servers = Array.from(merged.values(), (spec) => ({
    ...spec,
    lazy: lazy.has(spec.name),
    sourceEnabled: spec.enabled,
    enabled: enabled.has(spec.name) ? true : disabled.has(spec.name) ? false : spec.enabled,
  }));

  return { servers, reports, warnings };
}

/**
 * 某个 scope 下属于**外部工具**的候选文件。
 *
 * 单独导出是为了让导入标记能按同一份文件清单计算指纹——路径规则只留一处，两处各自
 * 拼一遍路径迟早会漂移，而漂移的后果是「标记说导过了，实际读的是另一批文件」。
 */
export function externalSourcePaths(scope: 'user' | 'project', options: DiscoverOptions): string[] {
  const workspaceRoot = options.host.canonicalize(options.workspaceRoot);
  const fromDir = resolve(options.fromDir ?? options.workspaceRoot);
  // 与 discoverMcpServers 保持同一套默认值：这里要是回退到 ~/.sph，两处算出的文件清单
  // 就不一致了，而导入标记正是按这份清单算指纹的。
  const home = options.home ?? homedir();
  if (scope === 'user') return [join(home, '.claude.json'), join(home, '.codex', 'config.toml')];
  const chain = chainDirs(workspaceRoot, fromDir, options.host);
  return [
    ...chain.map((dir) => join(dir, '.mcp.json')),
    ...chain.map((dir) => join(dir, '.codex', 'config.toml')),
    // `~/.claude.json` 的 `projects.<dir>` 段属于项目级来源，所以这份文件两个 scope 都要算。
    join(home, '.claude.json'),
  ];
}

/**
 * 项目级配置的查找链：从 `workspaceRoot` 到 `fromDir`，根在前、起点在后。
 *
 * 后读的覆盖先读的，于是「最近的目录赢」。只收 `workspaceRoot` 自身及其后代——启动目录
 * 在别处时不该把无关目录的项目级配置一并读进来。
 */
function chainDirs(workspaceRoot: string, fromDir: string, host: PluginHostFacts): string[] {
  const dirs: string[] = [];
  let current = resolve(fromDir);
  for (;;) {
    const rel = relative(workspaceRoot, current);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) dirs.push(current);
    if (host.canonicalize(current) === workspaceRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs.reverse();
}

function originOf(label: string, path: string, editable: boolean): McpOrigin {
  return { label, path, editable };
}

/** 合并过程中的形态：`sourceEnabled` / `enabled` 分化与 `lazy` 要等偏好叠加后才补上。 */
type MergedServer = Omit<DiscoveredMcpServer, 'sourceEnabled' | 'lazy'>;

/** 一条从某个文件读条目的通道。同一份文件可能被读两次（如 `.claude.json` 的两节）。 */
function readLayer(input: {
  label: string;
  paths: string[];
  reports: McpSourceReport[];
  warnings: string[];
  skipped?: string;
  read: (path: string, text: string) => Map<string, RawEntry>;
  toSpec: (name: string, entry: RawEntry, path: string) => MergedServer;
  put: (spec: MergedServer) => void;
}): void {
  if (input.skipped !== undefined) {
    for (const path of input.paths) {
      if (!existsSync(path)) continue;
      input.reports.push({ label: input.label, path, status: 'skipped', count: 0, detail: input.skipped });
    }
    return;
  }
  for (const path of input.paths) {
    if (!existsSync(path)) {
      input.reports.push({ label: input.label, path, status: 'missing', count: 0 });
      continue;
    }
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      input.reports.push({
        label: input.label,
        path,
        status: 'invalid',
        count: 0,
        detail: describeError(error),
      });
      continue;
    }
    let entries: Map<string, RawEntry>;
    try {
      entries = input.read(path, text);
    } catch (error) {
      // 外部配置解析失败不该让 sph 起不来：记一条报告 + 一条警告就够。
      const detail = describeError(error);
      input.reports.push({ label: input.label, path, status: 'invalid', count: 0, detail });
      input.warnings.push(`${input.label}: ${detail}`);
      continue;
    }
    input.reports.push({
      label: input.label,
      path,
      status: entries.size === 0 ? 'empty' : 'found',
      count: entries.size,
    });
    for (const [name, entry] of entries) input.put(input.toSpec(name, entry, path));
  }
}

type RawEntry = Omit<
  DiscoveredMcpServer,
  'name' | 'kind' | 'origin' | 'projectRoot' | 'sourceEnabled' | 'lazy'
>;

/**
 * `[mcp_servers.<name>]`。名字在表头上，不在 `name` 字段里。表内 `name` 只是显示名。
 *
 * `env_vars`（要继承的父进程环境变量名列表）在这里就地展开成具体值：sph 的 spawn 只接受
 * 一张现成的环境表，把「继承」留到 spawn 时会让签名比较也变复杂。
 */
function tomlMcpTable(
  text: string,
  path: string,
  warnings: string[],
  env: NodeJS.ProcessEnv,
): Map<string, RawEntry> {
  const root = asRecord(parseToml(text), path);
  const raw = root.mcp_servers;
  const out = new Map<string, RawEntry>();
  if (raw === undefined) return out;
  if (!isRecord(raw)) {
    warnings.push(`${path}: mcp_servers must be a table of tables ([mcp_servers.<name>])`);
    return out;
  }
  for (const [name, value] of Object.entries(raw)) {
    if (!isRecord(value)) {
      warnings.push(`${path}: mcp_servers.${name} must be a table`);
      continue;
    }
    const command = nonEmptyString(value.command);
    const url = nonEmptyString(value.url);
    if (command === undefined && url === undefined) {
      warnings.push(`${path}: mcp_servers.${name} needs a command or a url`);
      continue;
    }
    const merged = { ...stringMap(value.env) };
    for (const key of stringArray(value.env_vars) ?? []) {
      const inherited = env[key];
      if (inherited !== undefined) merged[key] = inherited;
    }
    out.set(name, {
      command,
      args: stringArray(value.args),
      env: Object.keys(merged).length === 0 ? undefined : merged,
      url,
      ...remoteFields(value, `${path}: mcp_servers.${name}`, warnings),
      ...displayTitle(value.name, name),
      enabled: value.enabled === undefined ? true : value.enabled === true,
    });
  }
  return out;
}

/**
 * `{"mcpServers": {...}}` 形态：`.mcp.json` 和用户主目录那份 JSON 共用。
 *
 * `claudeProject` 给定时，额外从 `projects.<dir>.mcpServers` 取条目；按 dir 从浅到深读，
 * 深的覆盖浅的。有的外部配置按精确 cwd 存，但仓库根的那份对本仓库的任意子目录都成立，
 * 所以按查找链逐级读比只认精确 cwd 实用。
 */
function jsonMcpServers(
  text: string,
  path: string,
  warnings: string[],
  options?: { claudeProject: string[] },
): Map<string, RawEntry> {
  const root = asRecord(JSON.parse(text) as unknown, path);
  if (options === undefined) return normalizeJsonServers(root.mcpServers, path, warnings);

  const out = new Map<string, RawEntry>();
  const projects = root.projects;
  if (projects === undefined) return out;
  if (!isRecord(projects)) {
    warnings.push(`${path}: projects must be an object`);
    return out;
  }
  for (const dir of options.claudeProject) {
    const entry = projects[dir];
    if (!isRecord(entry)) continue;
    for (const [name, spec] of normalizeJsonServers(entry.mcpServers, `${path} → projects.${dir}`, warnings)) {
      out.set(name, spec);
    }
  }
  return out;
}

/** JSON 配置里的单条 server：`command`/`args`/`env` 或 `url`，外加 `disabled`。 */
function normalizeJsonServers(value: unknown, where: string, warnings: string[]): Map<string, RawEntry> {
  const out = new Map<string, RawEntry>();
  if (value === undefined) return out;
  if (!isRecord(value)) {
    warnings.push(`${where}: mcpServers must be an object`);
    return out;
  }
  for (const [name, raw] of Object.entries(value)) {
    if (!isRecord(raw)) {
      warnings.push(`${where}: mcpServers.${name} must be an object`);
      continue;
    }
    const command = nonEmptyString(raw.command);
    const url = nonEmptyString(raw.url);
    if (command === undefined && url === undefined) {
      warnings.push(`${where}: mcpServers.${name} needs a command or a url`);
      continue;
    }
    const env = stringMap(raw.env);
    out.set(name, {
      command,
      args: stringArray(raw.args),
      env,
      url,
      ...remoteFields(raw, `${where}: mcpServers.${name}`, warnings),
      ...displayTitle(raw.name, name),
      // 两种外部字段都认：`disabled: true` 与 `enabled: false`。
      enabled: raw.disabled === true ? false : raw.enabled === undefined ? true : raw.enabled === true,
    });
  }
  return out;
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`invalid config file (not a table): ${path}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `transport` 与 JSON 里的 `type` 是同一个意思。写错了不丢掉整条 server：
 * 留下 url，让 hub 按默认传输去连，并在发现警告里说明原词。
 */
function remoteFields(
  row: Record<string, unknown>,
  where: string,
  warnings: string[],
): { transport?: 'stdio' | 'http' | 'sse'; headers?: Record<string, string> } {
  const declared = nonEmptyString(row.transport) ?? nonEmptyString(row.type);
  const normalized = normalizeTransport(declared);
  if (normalized === 'invalid') warnings.push(`${where}: unknown transport "${declared}"`);
  return {
    ...(normalized === 'stdio' || normalized === 'http' || normalized === 'sse' ? { transport: normalized } : {}),
    headers: stringMap(row.headers),
  };
}

/** 表内 `name` 是给人看的。与表头 ID 相同就不单记一份。 */
function displayTitle(value: unknown, id: string): { title: string } | undefined {
  const title = nonEmptyString(value);
  if (title === undefined || title === id) return undefined;
  return { title };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    // 非字符串的值（数字、嵌套表）直接丢：MCP 的 env 只能是字符串，保留下来只会在
    // spawn 时变成一个谁也看不懂的失败。
    if (typeof item === 'string') out[key] = item;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}
