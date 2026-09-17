import type { ToolSpec } from './types.js';

export interface OpenAiTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/**
 * 可注入的工具表。默认产品装 17 个内置工具；测试与自定义入口可换一份。
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

  schemas(allowed?: ReadonlySet<string>): OpenAiTool[] {
    return this.list()
      .filter((tool) => !allowed || allowed.has(tool.name))
      .map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.schema,
        },
      }));
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

  exploreNames(): Set<string> {
    return new Set(this.list().filter((tool) => tool.explore).map((tool) => tool.name));
  }

  /** general 子代理：全部非 rootOnly。 */
  generalNames(): Set<string> {
    return new Set(this.list().filter((tool) => !tool.rootOnly).map((tool) => tool.name));
  }
}
