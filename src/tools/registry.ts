import { stableValue } from '../util.js';
import type { ToolSpec } from './types.js';

export interface OpenAiTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/**
 * 可注入的工具表。测试与自定义入口可换一份。
 * 同名 register 拒绝——静默覆盖会让「我加的工具没生效」变成另一份定义在跑。
 */
export class ToolRegistry {
  private readonly byName = new Map<string, ToolSpec>();

  constructor(tools: readonly ToolSpec[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: ToolSpec): void {
    if (this.byName.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
    this.byName.set(tool.name, tool);
  }

  list(): ToolSpec[] {
    return [...this.byName.values()];
  }

  find(name: string): ToolSpec | undefined {
    return this.byName.get(name);
  }

  /**
   * 发给接口的工具声明。
   *
   * 按名字排序、参数键递归排序：注册顺序和 schema 字面量的键序都不该进请求字节，
   * 否则前缀缓存从工具段起整段重算。
   */
  schemas(allowed?: ReadonlySet<string>): OpenAiTool[] {
    const listed = this.list()
      .filter((tool) => !allowed || allowed.has(tool.name))
      .map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.schema,
        },
      }))
      .sort((a, b) => (a.function.name < b.function.name ? -1 : a.function.name > b.function.name ? 1 : 0));
    return stableValue(listed) as OpenAiTool[];
  }

  /** 未知名字 fail-closed：不当成只读。 */
  isConcurrencySafe(name: string): boolean {
    return this.byName.get(name)?.concurrencySafe === true;
  }

  isExploreTool(name: string): boolean {
    return this.byName.get(name)?.explore === true;
  }

  isRootOnly(name: string): boolean {
    return this.byName.get(name)?.rootOnly === true;
  }

  /** 计划模式下默认可调用。未知名字 fail-closed。 */
  isPlanSafe(name: string): boolean {
    return this.byName.get(name)?.planSafe === true;
  }

  exploreNames(): Set<string> {
    return new Set(this.list().filter((tool) => tool.explore).map((tool) => tool.name));
  }

  /** general 子代理：全部非 rootOnly。 */
  generalNames(): Set<string> {
    return new Set(this.list().filter((tool) => !tool.rootOnly).map((tool) => tool.name));
  }
}
