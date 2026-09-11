export type AgentEvent =
  | { type: 'status'; text: string }
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
  | { type: 'done' };

export type AgentListener = (event: AgentEvent) => void;
