/**
 * 插件发现与装载。
 *
 * ## 装载根（低 → 高，同名整条替换）
 *
 *   `src/plugins/`（内置）  <  `~/.sph/plugins`  <  `<workspaceRoot>/.sph/plugins`
 *
 * **内置插件与插件系统同住 `src/plugins/`**：它们随包编译进 `dist/plugins/`，是包的一部分，
 * 不是运行时才出现的源码。第三方一律走 `.sph/`——用户级 `~/.sph/plugins` 放常用插件，
 * 项目级 `<workspaceRoot>/.sph/plugins` 跟着仓库走（与 `.sph/config.toml` 同级，不往仓库根
 * 摆 `plugins/`）。同名时项目级赢：仓库里的声明比全局声明更贴近当下这次工作，与 MCP 来源
 * 的优先级规则一致。代价见 {@link DiscoveredPlugins.shadowed}。
 *
 * **项目级插件受信任门保护**：仓库里的 `.sph/plugins/*.ts` 是会被执行的任意代码，而仓库
 * 内容是别人写的。sph 已有工作区信任机制（`config.toml` 的 `trusted`），这里复用同一道门
 * ——只读别人的仓库不该执行他带来的代码。pi 的 `.pi/extensions` 同样只在项目受信任后装载。
 *
 * ## 单个插件坏掉不炸启动
 *
 * 每个插件独立 try/catch：导入失败、默认导出形态不对、setup 抛错、工具重名，都记成一条
 * 警告并继续装下一个。理由与 `[mcp_servers]` 坏条目降级一致——启动不该由最不重要的那个
 * 插件决定。装载失败必须**可见**（警告汇总上报），否则「插件没生效」会变成纯猜。
 *
 * ## 入口解析（与 pi 的 extensions 同构）
 *
 * 1. `package.json` 的 `sph.plugins` 数组（可多个入口，用于多文件插件）
 * 2. 目录下的 `index.ts` / `index.js`
 * 3. 单个 `*.ts` / `*.js` 文件本身就是插件（内置根除外，见 {@link defaultBundledRoot}）
 *
 * 只往下一层，不递归：复杂插件用 package.json 声明，别让发现规则变成猜谜。
 *
 * ## 第三方插件的运行时约束
 *
 * 第三方插件不经过本项目构建，由 Node 的原生类型擦除直接执行，因此 `PluginApi` 的说明里
 * 那两条硬约束（`.ts` 后缀、只用可擦除语法）只对它们成立。内置插件是编译产物，不受此限。
 */

import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sphHome } from '../home.js';
import { errorMessage } from '../util.js';

/**
 * 一个已发现的插件。
 *
 * `entries` 是**复数**：package.json 的 `sph.plugins` 可以声明多个入口文件，让一个插件由
 * 若干模块组成。它们属于同一个插件——共享名字，因此也共享禁用开关与工具重名检查。
 */
export interface PluginCandidate {
  name: string;
  /** 入口文件绝对路径，按声明顺序；全部装载、依次 setup。 */
  entries: string[];
  /** 装载根，用于诊断输出（区分内置 / 用户 / 项目）。 */
  root: 'bundled' | 'user' | 'project';
}

export interface DiscoverPluginsOptions {
  workspaceRoot: string;
  /** 用户级插件根；省略取 `~/.sph/plugins`。 */
  userRoot?: string;
  /** 内置插件根；省略按安装目录推算。 */
  bundledRoot?: string;
  /**
   * 工作区是否已信任。false 时**丢弃**项目级候选。
   * 省略即查 trusted.json（与 MCP 项目级来源同一道门）。
   */
  trusted?: boolean;
  /** `[plugins] disabled` 里的插件名，逐个丢掉。 */
  disabled?: readonly string[];
}

/**
 * 内置插件根：就是本文件所在的目录（源码树 `src/plugins/`，编译后 `dist/plugins/`）。
 *
 * 两种布局下都是「包内与插件系统同级的目录」，所以不需要任何路径推算。内置插件与插件
 * 系统同住一处，因此这个根**只认目录型插件**——`loader.ts` / `host.ts` / `types.ts`
 * 这些系统模块就摆在旁边，把裸文件也当插件会把系统认成插件。内置插件由 sph 自己维护，
 * 一律是含 `index.ts` 的目录；第三方根没有这个顾虑，两种形态都认。
 */
function defaultBundledRoot(): string {
  return dirname(fileURLToPath(import.meta.url));
}

const SCRIPT_EXTENSIONS = ['.ts', '.js', '.mjs'];

function hasScriptExtension(name: string): boolean {
  return SCRIPT_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/** package.json 里插件声明的字段名，与 `pi` 字段同理：宿主专属段，不污染通用字段。 */
interface SphManifest {
  name?: string;
  sph?: { name?: string; plugins?: unknown };
}

function readManifest(dir: string): SphManifest | undefined {
  const file = join(dir, 'package.json');
  if (!existsSync(file)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as SphManifest;
  } catch {
    // 清单坏掉当成没有清单：目录形式的插件仍可凭 index.ts 被发现。
    return undefined;
  }
}

/** 解析一个目录下声明的入口；没有则返回 undefined。 */
function resolveEntry(dir: string, root: PluginCandidate['root']): PluginCandidate | undefined {
  const manifest = readManifest(dir);
  const declared = manifest?.sph?.plugins;
  // 显式声明的名字优先于目录名：目录被重命名不该改变插件的身份（禁用列表按名字匹配）。
  const name = manifest?.sph?.name ?? manifest?.name ?? dir.split(/[\\/]/).pop() ?? dir;

  if (Array.isArray(declared) && declared.length > 0) {
    const entries: string[] = [];
    for (const item of declared) {
      if (typeof item !== 'string') continue;
      const entry = resolve(dir, item);
      if (existsSync(entry)) entries.push(entry);
    }
    if (entries.length > 0) return { name, entries, root };
  }

  for (const ext of SCRIPT_EXTENSIONS) {
    const entry = join(dir, `index${ext}`);
    if (existsSync(entry)) return { name, entries: [entry], root };
  }
  return undefined;
}

/**
 * 扫一个插件根：下一层的单文件与子目录，不递归。目录不存在即空。
 *
 * `directoriesOnly` 给内置根用：那里同时放着插件系统自己的模块，裸文件必须忽略
 * （见 {@link defaultBundledRoot}）。
 */
function scanRoot(
  dir: string,
  root: PluginCandidate['root'],
  directoriesOnly = false,
): PluginCandidate[] {
  if (!existsSync(dir)) return [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: PluginCandidate[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    // 单文件插件以文件名命名（`~/.sph/plugins/git-guard.ts` → `git-guard`）。目录型不许
    // 改名，否则 index.ts 与目录名会给出两个名字。
    if (!directoriesOnly && entry.isFile() && hasScriptExtension(entry.name)) {
      found.push({ name: entry.name.replace(/\.[^.]+$/, ''), entries: [full], root });
      continue;
    }
    if (entry.isDirectory()) {
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        const candidate = resolveEntry(full, root);
        if (candidate) found.push(candidate);
      }
    }
  }
  return found;
}

/**
 * 发现结果。
 *
 * `shadowed` 单独给出而不是让调用方自己推：只有发现过程知道哪些名字在**内置根里出现过、
 * 又被第三方顶掉**了。这是「行为变了却查不出为什么」的典型来源，必须让调用方有机会说出来。
 */
export interface DiscoveredPlugins {
  candidates: PluginCandidate[];
  /** 被第三方顶掉的内置插件名。 */
  shadowed: string[];
}

/**
 * 按优先级发现插件。同名只保留最高优先级的那条。
 *
 * 内置根**最低**：第三方声明比包自带的更贴近当下这次工作（与 MCP 来源同一套「近者胜」）。
 * 代价是工作区或用户目录里的插件能顶掉 `sph-mcp` 这类内置实现——信任门是唯一的防线，
 * 所以遮蔽在返回值里如实标出，由调用方上报。
 *
 * 返回的是**候选**：入口存在不代表能装载，真正的导入在 host 里做，失败降级为警告。
 */
export function discoverPlugins(options: DiscoverPluginsOptions): DiscoveredPlugins {
  const disabled = new Set(options.disabled ?? []);
  const roots: Array<{
    dir: string;
    kind: PluginCandidate['root'];
    take: boolean;
    directoriesOnly: boolean;
  }> = [
    {
      dir: options.bundledRoot ?? defaultBundledRoot(),
      kind: 'bundled',
      take: true,
      directoriesOnly: true,
    },
    {
      dir: options.userRoot ?? join(sphHome(), 'plugins'),
      kind: 'user',
      take: true,
      directoriesOnly: false,
    },
    {
      // 第三方跟随 sph 的项目目录约定（与 `.sph/config.toml` 同级），不往仓库根摆
      // `plugins/`：那会和源码目录混淆，而它是每个项目各自带一份的东西。
      dir: join(options.workspaceRoot, '.sph', 'plugins'),
      kind: 'project',
      take: options.trusted === true,
      directoriesOnly: false,
    },
  ];

  // 低优先级先入表，高优先级覆盖（与 MCP 来源合并同一套「同名整条替换」语义）。
  const byName = new Map<string, PluginCandidate>();
  const shadowed: string[] = [];
  const builtinNames = new Set<string>();
  for (const { dir, kind, take, directoriesOnly } of roots) {
    if (!take) continue;
    for (const candidate of scanRoot(dir, kind, directoriesOnly)) {
      if (kind !== 'bundled' && builtinNames.has(candidate.name)) shadowed.push(candidate.name);
      if (kind === 'bundled') builtinNames.add(candidate.name);
      byName.set(candidate.name, candidate);
    }
  }
  const candidates = [...byName.values()].filter((candidate) => !disabled.has(candidate.name));
  return { candidates, shadowed: [...new Set(shadowed)].sort() };
}

/** 动态导入一个插件入口，取出默认导出。 */
async function importPluginModule(entry: string): Promise<unknown> {
  const module = (await import(pathToFileURL(entry).href)) as { default?: unknown };
  return module.default;
}

/**
 * 一个插件装载失败的说明。
 *
 * 单独成结构而不是裸字符串：失败的可能是「导入就炸」也可能是「setup 里炸」，而这两者
 * 用户要做的事完全不同（前者看 Node 版本与语法，后者看插件逻辑）。
 */
export interface PluginLoadFailure {
  name: string;
  /** 该插件已经成功导入的入口；失败的那个在 reason 里说明。 */
  entries: string[];
  reason: string;
}

export interface LoadPluginsResult {
  candidates: PluginCandidate[];
  failures: PluginLoadFailure[];
}

/**
 * 把 `.ts` 入口在旧 Node 上的失败翻译成人话。
 *
 * 原生类型擦除是 ≥22.18（23 线 ≥23.6）才默认开启的，而 `engines` 只写了 `>=22`。
 * 不翻译的话，22.x 早期版本的用户看到的是 `Unknown file extension ".ts"`——这句话
 * 说了现象没说原因，而原因（升 Node 或改用 .js）恰恰是他需要知道的。
 */
function explainImportFailure(entry: string, message: string): string {
  if (/\.[cm]?ts$/.test(entry) && /Unknown file extension|ERR_UNKNOWN_FILE_EXTENSION/.test(message)) {
    const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
    const minor = Number.parseInt(process.versions.node.split('.')[1] ?? '0', 10);
    if (major < 22 || (major === 22 && minor < 18)) {
      return `${message} — .ts plugins need Node >= 22.18 (running ${process.versions.node}); either upgrade Node or ship the plugin as .js`;
    }
  }
  return message;
}

/**
 * 导入所有候选插件的默认导出，交给调用方执行 setup。
 *
 * 导入与执行分开：宿主需要在**所有**插件都装完之后才能确定工具表与服务表，而插件可能
 * 互相 consume。导入阶段只做「文件能不能读进来」。
 *
 * **一个入口失败即整个插件失败**：多入口插件是一个整体，半个插件跑起来比不跑更难查
 * （它的工具与服务可能互相依赖）。
 */
export async function loadPluginModules(
  candidates: PluginCandidate[],
): Promise<{ loaded: Array<{ candidate: PluginCandidate; modules: unknown[] }>; failures: PluginLoadFailure[] }> {
  const loaded: Array<{ candidate: PluginCandidate; modules: unknown[] }> = [];
  const failures: PluginLoadFailure[] = [];
  for (const candidate of candidates) {
    try {
      const modules: unknown[] = [];
      for (const entry of candidate.entries) {
        modules.push(await importPluginModule(entry));
      }
      loaded.push({ candidate, modules });
    } catch (error) {
      failures.push({
        name: candidate.name,
        entries: [...candidate.entries],
        reason: explainImportFailure(candidate.entries[0] ?? '', errorMessage(error)),
      });
    }
  }
  return { loaded, failures };
}

/** 用户级插件根，供 CLI 与文档共用一处定义。 */
export function userPluginsRoot(): string {
  return join(sphHome(), 'plugins');
}

/** `~` 归位，供诊断输出把绝对路径写成用户看得懂的短形式。 */
export function tildify(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}
