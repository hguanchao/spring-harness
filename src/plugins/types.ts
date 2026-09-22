/**
 * 插件契约。
 *
 * 一个插件就是一个模块，默认导出工厂函数（或带 `setup` 的对象）；宿主调用它并交出
 * `PluginApi`——插件据此注册工具、提供服务、登记清理。MCP 就是这样从核心搬出去的
 * 第一个插件（`plugins/sph-mcp`），核心不再 import 它的实现。
 *
 * ## 插件只从 core 引类型
 *
 * `import type { … } from '../../src/…'` 在运行时被类型擦除，**不会**产生模块解析；
 * 而普通 import 会：sph 跑的是构建产物 `dist/`，插件源码在 `plugins/`，两棵目录树在
 * 运行时并不相邻。所以插件的一切运行时能力都经 `PluginApi` 拿，不直接 import 宿主实现。
 *
 * ## 运行时加载方式
 *
 * Node 用原生类型擦除直接执行 `.ts`（≥22.18 默认开启，无需 flag），由此带来两条硬约束：
 *
 * 1. **同目录 import 必须写 `.ts` 后缀。** Node 不做 `.js` → `.ts` 的替换，写 `./hub.js`
 *    会直接 MODULE_NOT_FOUND。TS 侧由 `allowImportingTsExtensions` 放行。
 * 2. **只能用可擦除语法。** enum、带运行时代码的 namespace、构造函数参数属性都需要代码
 *    生成，Node 拒绝执行（ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX）。
 *
 * 两条都由 `tsconfig.plugins.json` 的 `erasableSyntaxOnly` / `allowImportingTsExtensions`
 * 在类型检查阶段卡住——坏插件在运行时才炸的话，用户看到的是启动横幅里的一条警告。
 */

import type { ToolContext, ToolSpec } from '../tools/types.js';

/**
 * 服务注册表：只读视图。
 *
 * 服务是插件之间（以及插件与宿主界面之间）唯一的通信方式——没有全局单例、没有 import
 * 对方实现。写入只能经 `PluginApi.provide`，所以「谁提供了什么」在一个地方说得清。
 */
export interface PluginServices {
  /** 取一个服务；未提供（插件被禁用 / 加载失败）返回 undefined。 */
  get<T>(name: string): T | undefined;
  has(name: string): boolean;
  /** 已提供的服务名，供诊断输出。 */
  names(): string[];
}

/**
 * 宿主事实与宿主策略。
 *
 * 插件**不得自己复制**这些：凭据擦除是安全语义，信任判定是授权语义，两份实现迟早分叉；
 * `sphHome` 与路径规范化是宿主的目录约定。插件只从 core 引类型的代价，就是这些能力必须
 * 由宿主显式交出来——露在 api 上恰好让「插件依赖宿主的什么」一眼可见。
 */
export interface PluginHostFacts {
  /** sph 状态目录（`~/.sph`）。插件要读宿主状态时用它，不要自己拼 home。 */
  readonly sphHome: string;
  /**
   * 子进程环境：擦掉凭据（`*KEY*` / `*TOKEN*` / `*SECRET*` / `*PASSWORD*`、`SPH_*`）的父环境，
   * 再叠显式条目——显式条目可覆盖擦除，让用户故意转交的密钥仍能到达目标进程。
   * 插件 spawn 子进程时必须用它，直接传 process.env 会把 sph 的 API key 送出去。
   */
  mergeChildEnv(extra?: Record<string, string>): Record<string, string>;
  /** 工作区路径规范化（realpath + 平台大小写）。比较两个路径是否同一处时必须过它。 */
  canonicalize(path: string): string;
  /** 工作区是否已信任（查 config.toml 的 trusted 列表）。 */
  isWorkspaceTrusted(workspaceRoot: string): boolean;
}

/** 宿主交给插件的能力面。 */
export interface PluginApi {
  /** 插件名：取自 package.json 的 `sph.name`，否则取目录名（单文件插件取文件名）。 */
  readonly name: string;
  readonly workspaceRoot: string;
  /** config.toml 路径：插件要读写宿主配置时用它定位，不必自己拼 `~/.sph`。 */
  readonly configPath: string;
  /** 宿主事实与策略。 */
  readonly host: PluginHostFacts;
  /**
   * 注册一个模型可调用的工具。
   *
   * 工具重名会抛错（核心工具表里已有的名字同样算重名）——静默覆盖会让「我加的工具没生效」
   * 变成另一个工具在跑。抛出的错被宿主记成该插件的加载警告，不影响其它插件。
   */
  registerTool(tool: ToolSpec): void;
  /** 暴露一个服务。同名重复 provide 抛错：两个插件抢同一个名字必须被看见。 */
  provide(name: string, service: unknown): void;
  /** 取用别处提供的服务。 */
  consume<T>(name: string): T | undefined;
  /** 记一条用户可见的警告；随插件状态一起显示，不中断启动。 */
  warn(message: string): void;
  /**
   * 宿主输出上限：插件产出模型可读文本时统一用它。
   * 让每个插件自己发明一个截断数字，等于把同一份宿主策略散到各处。
   */
  clip(text: string, limit?: number): string;
  /** 登记清理回调；逆序执行，单个回调抛错不影响其余。 */
  onDispose(fn: () => void): void;
}

/** 对象形式的插件：默认导出 `{ name, setup }`。 */
export interface SphPlugin {
  /** 覆盖插件名；省略则用目录名。 */
  name?: string;
  setup(api: PluginApi): void | Promise<void>;
}

/** 函数形式的插件：默认导出工厂。工厂可以是 async，宿主会 await。 */
export type PluginFactory = (api: PluginApi) => void | Promise<void>;

/** 插件模块的默认导出。 */
export type PluginModule = PluginFactory | SphPlugin;

/** 校验一个默认导出是否是宿主认得的插件形态。 */
export function isPluginObject(value: unknown): value is SphPlugin {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SphPlugin).setup === 'function'
  );
}

/** 工具执行上下文里那个只读服务视图——插件工具靠它取兄弟服务。 */
export type PluginToolContext = ToolContext & { services: PluginServices };

/**
 * 空服务表。测试与「没有装任何插件」的路径用它，省得每处都判空。
 * 取任何服务都得到 undefined——正是调用方必须处理的那条路径。
 */
export const EMPTY_PLUGIN_SERVICES: PluginServices = {
  get: () => undefined,
  has: () => false,
  names: () => [],
};
