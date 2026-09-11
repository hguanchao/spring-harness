import type { JobBoard } from '../runtime/jobs.js';
import type { PersistentShell } from '../runtime/persistent-shell.js';
import type { McpHub } from '../mcp/hub.js';
import type { TodoList } from '../runtime/todos.js';
import type { SkillEntry } from '../skills/scan.js';

export interface ToolResult {
  ok: boolean;
  content: string;
  /** 工具产出的图片（data URL），由 loop 注入后续消息上下文。 */
  images?: string[];
}

export interface PlanExitResult {
  approved: boolean;
  feedback?: string;
}

/** 工具执行需要的一切。只放工具真正会读的成员——冗余字段会让每个新工具都要假装理解它们。 */
export interface ToolContext {
  workspaceRoot: string;
  sandboxMode: 'off' | 'workspace' | 'read-only';
  signal?: AbortSignal;
  /** spill 落盘根目录；read_file 只允许在工作区之外额外读这个目录。 */
  spillRoot?: string;
  skills: SkillEntry[];
  todos: TodoList;
  jobs: JobBoard;
  persistent: PersistentShell;
  mcp: McpHub;
  runShell(command: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
  approve(tool: string, detail: string): Promise<boolean>;
  askUser(prompt: string): Promise<string>;
  escalateReadOnlyWrite?(path: string): Promise<boolean>;
  /** exit_plan_mode：把计划提交给用户审批，approved=true 时 loop 会退出 plan mode。 */
  exitPlan(plan: string): Promise<PlanExitResult>;
  /** 工具触碰文件后调用，用于把触碰到的嵌套 AGENTS.md 注入上下文。 */
  noteMemoryTouch(absPath: string): void;
  spawnSubagent(input: {
    prompt: string;
    type: 'explore' | 'general';
    background?: boolean;
    description?: string;
  }): Promise<string>;
}

export interface ToolSpec {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export function asString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${key} is required`);
  }
  return value;
}

export function asOptionalBool(args: Record<string, unknown>, key: string): boolean {
  return args[key] === true;
}

export function asOptionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export const OUTPUT_LIMIT = 32 * 1024;

export function clip(text: string, limit = OUTPUT_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`;
}
