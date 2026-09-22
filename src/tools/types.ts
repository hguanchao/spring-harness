import type { FileObservation } from './observe.js';
import type { PluginServices } from '../plugins/types.js';
import type { JobBoard } from '../runtime/jobs.js';
import type { TodoService } from '../plugins/services.js';
import { assertWriteAllowed } from '../sandbox/policy.js';
import type { SandboxMode } from '../sandbox/types.js';
import type { SkillEntry } from '../skills/scan.js';

export interface ToolResult {
  ok: boolean;
  content: string;
  /** 工具产出的图片（data URL），由 loop 注入后续消息上下文。 */
  images?: string[];
}

/** 工具执行需要的一切。只放工具真正会读的成员——冗余字段会让每个新工具都要假装理解它们。 */
export interface ToolContext {
  workspaceRoot: string;
  sandboxMode: SandboxMode;
  signal?: AbortSignal;
  /** spill 落盘根目录；read_file 只允许在工作区之外额外读这个目录。 */
  spillRoot?: string;
  skills: SkillEntry[];
  /** todo 服务；todo 插件被禁用时不可用。核心工具只有 todo 工具用它。 */
  todos: TodoService;
  jobs: JobBoard;
  /**
   * 插件提供的服务表。核心工具用不到它；插件工具靠它取兄弟插件的服务
   * （如 `sph-mcp` 的 hub）。缺席的服务取到 undefined——调用方必须处理。
   */
  services: PluginServices;
  runShell(
    command: string,
    timeoutMs: number,
    kind: 'bash' | 'pwsh',
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
  approve(tool: string, detail: string): Promise<boolean>;
  askUser(prompt: string): Promise<string>;
  escalateReadOnlyWrite?(path: string): Promise<boolean>;
  /** 工具触碰文件后调用，用于把触碰到的嵌套 AGENTS.md 注入上下文。 */
  noteMemoryTouch(absPath: string): void;
  /** 本轮读/写观察；省略则不强制先读后写（测试可关掉）。 */
  observation?: FileObservation;
  spawnSubagent(input: {
    prompt: string;
    type: 'explore' | 'general';
    background?: boolean;
    description?: string;
    /** 主流程里这次 `subagent` 工具调用的 id；恢复会话时子任务块靠它对齐回放位置。 */
    toolCallId?: string;
    /** 续接一个已完成的子代理会话（传其 session id）：源消息复制进新会话。 */
    resumeFrom?: string;
    /** worktree：在隔离的 git 工作树里跑（解析失败即 spawn 失败）。 */
    isolation?: 'none' | 'worktree';
  }): Promise<string>;
  /** 给仍在跑的后台子代理投递一条消息（root-only 工具的底层通道）。 */
  sendToSubagent(id: string, text: string): 'queued' | 'not_found' | 'completed';
  /** 与 runTurn 共享的计划模式开关；子代理不设。 */
  planMode?: { active: boolean };
  sessionDir?: string;
  sessionId?: string;
  setPlanMode?(active: boolean): void;
  /** 把完整计划呈给用户评审；取消/继续规划时 approved=false。 */
  reviewPlan?(plan: string, title: string): Promise<{ approved: boolean; feedback?: string }>;
}

export interface ToolSpec {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  /** 同一步可与其它 concurrencySafe 工具并行。缺省 exclusive（未知工具 fail-closed）。 */
  concurrencySafe?: boolean;
  /** explore 子代理可用。缺省否。 */
  explore?: boolean;
  /** 仅根会话可见。缺省否。 */
  rootOnly?: boolean;
  /**
   * callId 是这次调用在主流程里的工具调用 id（并行执行时各不相同）。
   * 绝大多数工具用不到它；subagent 靠它把子任务块锚回调用行。
   */
  execute(args: Record<string, unknown>, ctx: ToolContext, callId?: string): Promise<ToolResult>;
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

/** 可选字符串：缺省或非字符串当空串。write 的 content / search_replace 的 new_string 允许空。 */
export function asStringOrEmpty(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

/**
 * 写工具在只读沙箱下的统一前置检查：允许 ctx.escalateReadOnlyWrite 申请一次放行。
 * 返回非 undefined 即「拒绝」，调用方直接把它交给模型。
 */
export async function guardReadOnlyWrite(
  ctx: ToolContext,
  relPath: string,
  tool: 'write' | 'edit',
): Promise<ToolResult | undefined> {
  if (ctx.sandboxMode === 'read-only') {
    const allowed = ctx.escalateReadOnlyWrite ? await ctx.escalateReadOnlyWrite(relPath) : false;
    if (!allowed) return { ok: false, content: `${tool} is denied under read-only sandbox` };
    return undefined;
  }
  assertWriteAllowed(ctx.sandboxMode, tool);
  return undefined;
}

const OUTPUT_LIMIT = 32 * 1024;

/**
 * 单轮内并行前台 subagent 上限：fan-out 调研的常见 sweet spot，超出排队而非拒绝。
 * 放在这里是为了让 subagent 的工具描述能直接引用，避免文案与实现各写一个数字。
 */
export const SUBAGENT_CONCURRENCY = 3;

export function clip(text: string, limit = OUTPUT_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`;
}
