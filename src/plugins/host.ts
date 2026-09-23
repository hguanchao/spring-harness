/**
 * 插件宿主：执行插件、汇总它们注册的工具与服务、统一清理。
 *
 * 装载分两阶段，顺序不能换：
 *
 * 1. **导入**（loader）：把模块读进来，只判断「文件能不能读、默认导出形态对不对」。
 * 2. **setup**（这里）：按发现顺序逐个执行，此时工具表与服务表才逐步成形。
 *
 * 分开的原因是插件之间会互相 `consume`：`sph-mcp` 提供的服务可能被后装的插件用到。
 * 若边导入边执行，插件看到的服务表就取决于文件系统的读入顺序——那是随机的。
 *
 * 反过来，**导入失败不阻断后续导入**、**setup 失败不阻断后续 setup**：一个坏插件不该
 * 让其余的失效。失败一律落进 warnings/failures，最终由 CLI 上报。
 */

import { sphHome } from '../home.js';
import { mergeChildEnv } from '../sandbox/env.js';
import { ToolRegistry } from './sph-tools/index.js';
import { clip, type ToolSpec } from '../tools/types.js';
import { errorMessage } from '../util.js';
import { canonicalize } from '../workspace/boundary.js';
import { isWorkspaceTrusted } from '../workspace/trust.js';
import { loadPluginModules, type PluginCandidate, type PluginLoadFailure } from './loader.js';
import { isPluginObject, type PluginApi, type PluginFactory, type PluginHostFacts, type PluginServices } from './types.js';

/** 一个已装载插件的摘要，供 `sph plugins` 与诊断输出用。 */
export interface LoadedPlugin {
  name: string;
  entries: string[];
  root: PluginCandidate['root'];
  /** 该插件注册的工具名，按注册顺序。 */
  tools: string[];
  /** 该插件提供的服务名。 */
  services: string[];
  /** 该插件自己报的问题（api.warn）与宿主判定的问题（重名、setup 抛错）。 */
  warnings: string[];
}

export interface PluginHostOptions {
  /** 核心工具表：既作为最终表的基底，也用于检出插件与核心的重名。 */
  coreTools: readonly ToolSpec[];
  workspaceRoot: string;
  configPath: string;
}

interface PluginRecord {
  candidate: PluginCandidate;
  tools: ToolSpec[];
  services: string[];
  warnings: string[];
  disposers: Array<() => void>;
}

export class PluginHost implements PluginServices {
  private readonly options: PluginHostOptions;
  private readonly records: PluginRecord[] = [];
  private readonly serviceMap = new Map<string, unknown>();
  private readonly serviceOwners = new Map<string, string>();
  private readonly failures: PluginLoadFailure[] = [];
  /** 被第三方顶掉的内置插件名；由发现阶段给出（见 loader.ts 的 DiscoveredPlugins）。 */
  private readonly shadowed: string[] = [];
  /** 试图顶掉固定内置插件、但被拒绝的名字。内置实现仍装载。 */
  private readonly pinned: string[] = [];
  private readonly order: string[] = [];
  private disposed = false;

  constructor(options: PluginHostOptions) {
    this.options = options;
  }

  /**
   * 导入并执行所有候选插件。
   *
   * 传入的是 loader 给的候选（已按优先级去重、已剔除禁用项）；本方法不再做发现决策，
   * 只负责「装」与「记录」。
   */
  async load(
    candidates: readonly PluginCandidate[],
    shadowed: readonly string[] = [],
    pinned: readonly string[] = [],
  ): Promise<void> {
    this.shadowed.push(...shadowed);
    this.pinned.push(...pinned);
    const { loaded, failures } = await loadPluginModules([...candidates]);
    this.failures.push(...failures);

    for (const { candidate, modules } of loaded) {
      const record: PluginRecord = {
        candidate,
        tools: [],
        services: [],
        warnings: [],
        disposers: [],
      };
      this.records.push(record);
      this.order.push(candidate.name);
      // 多入口插件按声明顺序依次 setup，共享同一条记录：它们是同一个插件，因此共享
      // 名字，也共享工具重名检查与禁用开关。
      for (const module of modules) {
        try {
          await this.runSetup(module, record);
        } catch (error) {
          // setup 中途抛错：已经登记的清理回调与已注册的工具都保留——半装的插件比装作
          // 没装过更接近事实，而它的清理回调正是用户卸载它时的依据。
          record.warnings.push(`setup failed: ${errorMessage(error)}`);
        }
      }
    }
  }

  private async runSetup(module: unknown, record: PluginRecord): Promise<void> {
    const factory = this.buildApi(record);
    if (typeof module === 'function') {
      await (module as PluginFactory)(factory);
      return;
    }
    if (isPluginObject(module)) {
      await module.setup(factory);
      return;
    }
    throw new Error(
      'default export must be a plugin factory function or an object with setup()',
    );
  }

  /** 为单个插件构造 api：一切写入都落到该插件自己的记录上，插件之间不共享可变状态。 */
  private buildApi(record: PluginRecord): PluginApi {
    const name = record.candidate.name;
    const api: PluginApi = {
      name,
      workspaceRoot: this.options.workspaceRoot,
      configPath: this.options.configPath,
      host: this.hostFacts(),
      registerTool: (tool: ToolSpec): void => {
        this.assertToolNameFree(tool.name, record);
        record.tools.push(tool);
      },
      provide: (serviceName: string, service: unknown): void => {
        const owner = this.serviceOwners.get(serviceName);
        if (owner !== undefined) {
          throw new Error(`service "${serviceName}" is already provided by plugin "${owner}"`);
        }
        this.serviceOwners.set(serviceName, name);
        this.serviceMap.set(serviceName, service);
        record.services.push(serviceName);
      },
      consume: <T>(serviceName: string): T | undefined => this.serviceMap.get(serviceName) as T | undefined,
      warn: (message: string): void => {
        record.warnings.push(message);
      },
      clip,
      onDispose: (fn: () => void): void => {
        record.disposers.push(fn);
      },
    };
    return api;
  }

  /**
   * 宿主事实与策略。每次构造 api 时新建一份：它是无状态的转发，插件之间没有共享面，
   * 也就不存在某个插件改了「宿主行为」影响别人这种局面。
   */
  private hostFacts(): PluginHostFacts {
    return {
      sphHome: sphHome(),
      mergeChildEnv: (extra?: Record<string, string>) => mergeChildEnv(extra),
      canonicalize: (path: string) => canonicalize(path),
      isWorkspaceTrusted: (workspaceRoot: string) => isWorkspaceTrusted(workspaceRoot),
    };
  }

  /**
   * 工具名必须全局唯一：与核心重名会静默顶掉核心工具，与另一个插件重名则两者谁生效
   * 取决于装载顺序。两种都不可接受，所以直接抛错（被记成该插件的加载警告）。
   */
  private assertToolNameFree(toolName: string, record: PluginRecord): void {
    if (this.options.coreTools.some((tool) => tool.name === toolName)) {
      throw new Error(`tool "${toolName}" collides with a built-in tool`);
    }
    for (const other of this.records) {
      if (other === record) continue;
      if (other.tools.some((tool) => tool.name === toolName)) {
        throw new Error(`tool "${toolName}" collides with plugin "${other.candidate.name}"`);
      }
    }
    // 同一个插件内部重复注册同名工具也拦下：那是插件自己的 bug，早报早修。
    if (record.tools.some((tool) => tool.name === toolName)) {
      throw new Error(`tool "${toolName}" is registered twice by "${record.candidate.name}"`);
    }
  }

  /** 核心 + 插件工具，合成最终工具表。 */
  tools(): ToolRegistry {
    const pluginTools = this.records.flatMap((record) => record.tools);
    return new ToolRegistry([...this.options.coreTools, ...pluginTools]);
  }

  /** 取一个服务；插件被禁用 / 加载失败时返回 undefined——调用方必须处理缺席。 */
  get<T>(name: string): T | undefined {
    return this.serviceMap.get(name) as T | undefined;
  }

  has(name: string): boolean {
    return this.serviceMap.has(name);
  }

  names(): string[] {
    return [...this.serviceMap.keys()];
  }

  /** 已装载插件摘要 + 导入期失败 + 被遮蔽的内置插件，供 `/plugins` 与启动警告。 */
  report(): { plugins: LoadedPlugin[]; failures: PluginLoadFailure[]; shadowed: string[]; pinned: string[] } {
    return {
      shadowed: [...this.shadowed],
      pinned: [...this.pinned],
      plugins: this.records.map((record) => ({
        name: record.candidate.name,
        entries: [...record.candidate.entries],
        root: record.candidate.root,
        tools: record.tools.map((tool) => tool.name),
        services: [...record.services],
        warnings: [...record.warnings],
      })),
      failures: [...this.failures],
    };
  }

  /** 启动横幅与 `/plugins` 用的一行警告；无问题时为空数组。 */
  warnings(): string[] {
    const lines: string[] = [];
    for (const failure of this.failures) {
      lines.push(`plugin ${failure.name}: ${failure.reason}`);
    }
    for (const record of this.records) {
      for (const warning of record.warnings) {
        lines.push(`plugin ${record.candidate.name}: ${warning}`);
      }
    }
    return lines;
  }

  /**
   * 逆序清理：后装的插件可能依赖先装的服务，先拆后者才不会让前者在拆卸期拿到半死的依赖。
   * 单个回调抛错不影响其余——清理阶段不该因为一个插件而漏掉别的插件的释放。
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (let i = this.records.length - 1; i >= 0; i--) {
      const record = this.records[i]!;
      for (let j = record.disposers.length - 1; j >= 0; j--) {
        try {
          record.disposers[j]!();
        } catch (error) {
          process.stderr.write(`plugin ${record.candidate.name} dispose failed: ${errorMessage(error)}\n`);
        }
      }
    }
    this.serviceMap.clear();
    this.serviceOwners.clear();
  }
}
