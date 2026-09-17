/**
 * 子代理（subagent job）内部事件的嵌套载体。
 *
 * 子代理的 runTurn 曾经直接把事件打进主 listener：主/子活动在 TUI 里混成一条流，
 * 既分不清归属，也无法折叠。现在子事件封进 subagent_event，消费端按 id 路由进
 * 对应的子任务块。注意：这里刻意不含 usage / ask / done——前两者是全局性的
 * （用量计数、审批提示），done 由 subagent_end 表达。
 */
export type SubagentEvent =
  | { type: 'text'; text: string }
  | { type: 'status'; text: string; level?: 'dim' | 'warn' | 'error' }
  | { type: 'thinking_start'; id: string }
  | { type: 'thinking_delta'; id: string; text: string }
  | { type: 'thinking_end'; id: string; content: string }
  | { type: 'tool_start'; name: string; id: string; args: Record<string, unknown> }
  | { type: 'tool_end'; name: string; id: string; ok: boolean; content: string }
  | { type: 'error'; text: string }
  /** 该子代理一次 LLM 调用的用量，供 dock 右侧实时累计。 */
  | { type: 'usage'; promptTokens: number; completionTokens: number };

export type AgentEvent =
  | { type: 'status'; text: string; level?: 'dim' | 'warn' | 'error' }
  /** 传输重试：丢掉本步已流出、尚未落盘的思考/正文。 */
  | { type: 'stream_retry' }
  | { type: 'text'; text: string }
  /** 一次 LLM 调用的思考期开始：TUI 在对话流中挂出对应的 thinking 行。 */
  | { type: 'thinking_start'; id: string }
  /** 思考链增量（推理模型/扩展思考）。端点不流式思考时不会有这个事件。 */
  | { type: 'thinking_delta'; id: string; text: string }
  /** 思考结束：content 为思考链全文，是权威值——消费端应整体替换而不是拼接。 */
  | { type: 'thinking_end'; id: string; content: string }
  | { type: 'tool_start'; name: string; id: string; args: Record<string, unknown> }
  | { type: 'tool_end'; name: string; id: string; ok: boolean; content: string }
  | { type: 'ask'; id: string; tool: string; detail: string }
  /** cachedTokens 仅在端点上报告缓存用量时出现（命中提示缓存的输入 token）。 */
  | { type: 'usage'; promptTokens: number; completionTokens: number; cachedTokens?: number }
  | { type: 'error'; text: string }
  /**
   * 子任务块开始：TUI 据此开出一个可展开的子任务块（Claude 风格的实时容器）。
   * toolCallId 是主流程里那次 `subagent` 工具调用的 id——恢复会话时靠它把块
   * 对齐回放流里的工具行。
   */
  | {
      type: 'subagent_start';
      id: string;
      description: string;
      mode: 'foreground' | 'background';
      childType: 'explore' | 'general';
      childSessionId: string;
      toolCallId?: string;
      /** 子代理跑在隔离 git 工作树时的工作树路径（isolation: worktree）。 */
      worktree?: string;
    }
  /** 子代理的内部事件；消费端按 id 路由，绝不进主流程的步骤块。 */
  | { type: 'subagent_event'; id: string; event: SubagentEvent }
  /**
   * 子任务块结束。summary 是子代理的最终报告（权威全文，覆盖内部流式攒出的草稿）；
   * ok=false 时 summary 是错误信息。tokens 是该子代理（含嵌套后代——后代的 usage 沿
   * 监听器链直接上抛，天然归并进父计数）全部 LLM 调用的 prompt+completion 总量。
   * resumedFrom / worktree 标记该子代理是续接产物 / 跑在隔离工作树里。
   */
  | {
      type: 'subagent_end';
      id: string;
      ok: boolean;
      durationMs: number;
      summary: string;
      tokens: number;
      resumedFrom?: string;
      worktree?: string;
    }
  | { type: 'done' };

export type AgentListener = (event: AgentEvent) => void;
