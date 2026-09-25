/**
 * 一轮对话的驱动契约。
 *
 * 实现在 sph-loop。宿主、界面和嵌入方只按这个形状调用，换循环插件不用改调用点。
 */
import type { AgentListener } from './events.js';
import type { LlmClient, TokenUsage } from '../llm/client.js';
import type { Approver } from '../permission/policy.js';
import type { SpillStorePort, TodoService, WorktreePort } from '../plugins/services.js';
import type { PluginHook, PluginServices } from '../plugins/types.js';
import type { JobBoardPort, SubagentInbox } from '../runtime/scheduler.js';
import type { SandboxHandle } from '../sandbox/types.js';
import type { DocumentAttachment, FileAttachment, SessionFactory, SessionFailure, SessionPort } from '../session/types.js';
import type { ToolRegistry } from '../tools/registry.js';

/** 循环用来记下工具触碰过的路径，并在下一步取走要注入的指令。 */
export interface MemoryPort {
  noteTouch(absPath: string): void;
  drain(): { relPath: string; text: string }[];
}

export interface RunTurnOptions {
  prompt: string;
  workspaceRoot: string;
  client: LlmClient;
  /** 当前模型名，写入系统提示词身份段。省略则身份段不写 Model。 */
  model?: string;
  session: SessionPort;
  tools: ToolRegistry;
  /** 可注入会话工厂；省略用 JSONL。子代理 spawn / resume 走这里。 */
  sessions?: SessionFactory;
  sandbox: SandboxHandle;
  approver: Approver;
  /**
   * 子代理专用的审批器；省略则复用 approver。
   * strict 时调用方传入 fail-closed 的审批器。策略留在调用方，循环只负责选用。
   */
  subagentApprover?: Approver;
  contextWindow: number;
  listener?: AgentListener;
  signal?: AbortSignal;
  /** 插件服务表。循环按名字取用；没装的能力取到 undefined，对应提示词段落随之消失。 */
  services?: PluginServices;
  /** 工具前后和回合结束的钩子。省略等于没有钩子。 */
  hooks?: readonly PluginHook[];
  /** todo 服务；省略时从插件服务表取。 */
  todos?: TodoService;
  jobs?: JobBoardPort;
  depth?: number;
  allowedTools?: ReadonlySet<string>;
  /** 用户随本条 prompt 提交的图片（data URL）。 */
  userImages?: string[];
  /** 用户随本条 prompt 提交的 PDF 文档（data URL）。 */
  userDocuments?: DocumentAttachment[];
  /** 用户以 @路径 提及的文件附件。 */
  attachments?: FileAttachment[];
  memory?: MemoryPort;
  /** 跨轮次任务目标（来自会话折叠）。 */
  goal?: string;
  /** 上一次工具失败（来自会话折叠）。 */
  lastFailure?: SessionFailure;
  /** 超长工具结果落盘。未提供则结果原样进上下文。 */
  spill?: SpillStorePort;
  /**
   * 子代理嵌套深度预算：0 禁止派生，默认 1。
   * 超额调用在运行时拒绝。
   */
  maxSubagentDepth?: number;
  /**
   * 一轮的模型调用上限。省略不限制。
   * 子会话在最后几步收束，到顶后把已有正文作为失败结果交回父代理。
   */
  maxTurns?: number;
  /** 压缩摘要专用 client；省略用主 client。 */
  compactClient?: LlmClient;
  /** 辅助调用产生的用量。记账，但不参与上下文水位。 */
  onAuxUsage?: (usage: TokenUsage, purpose: string) => void;
  /** 父级发来的消息。每步顶部 drain，不打断当前模型调用。 */
  inbox?: SubagentInbox;
  /** 子代理 worktree 仓库；省略时按需新建。 */
  worktrees?: WorktreePort;
  /** 计划模式开关。enter/exit 会原地翻转，下一步重读。 */
  planMode?: { active: boolean };
  reviewPlan?: (plan: string, title: string) => Promise<{ approved: boolean; feedback?: string }>;
  /**
   * 追加在主系统提示词之后的角色约束。
   * 子会话由派生时传入；根会话由 `/agent` 选中的定义传入。
   */
  subagentPrompt?: string;
  /**
   * 会话累计 token 预算。0 或省略表示不限制。
   * 开启时循环自己从会话记录折叠用量。
   */
  maxSessionTokens?: number;
}

export type AgentDriver = (options: RunTurnOptions) => Promise<void>;
