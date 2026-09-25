/**
 * 一轮对话的事件协议。
 *
 * 循环插件负责发出这些事件，headless 输出和界面负责消费。形状留在宿主，
 * 这样换掉 sph-loop 或 sph-tui 时，两边仍对着同一份契约，而不是各自发明一种。
 */

/** 子代理内部事件。不含 usage / ask / done：前两者是全局的，done 由 subagent_end 表达。 */
export type SubagentEvent =
  | { type: 'text'; text: string }
  | { type: 'status'; text: string; level?: 'dim' | 'warn' | 'error' }
  | { type: 'thinking_start'; id: string }
  | { type: 'thinking_delta'; id: string; text: string }
  | { type: 'thinking_end'; id: string; content: string }
  | { type: 'tool_start'; name: string; id: string; args: Record<string, unknown> }
  | { type: 'tool_end'; name: string; id: string; ok: boolean; content: string }
  | { type: 'error'; text: string }
  /** 该子代理一次 LLM 调用的用量，供界面右侧实时累计。costUsd 仅在模型声明了单价时出现。 */
  | { type: 'usage'; promptTokens: number; completionTokens: number; costUsd?: number };

export type AgentEvent =
  | { type: 'status'; text: string; level?: 'dim' | 'warn' | 'error' }
  /** 传输重试：丢掉本步已流出、尚未落盘的思考/正文。 */
  | { type: 'stream_retry' }
  | { type: 'text'; text: string }
  /** 一次 LLM 调用的思考期开始。 */
  | { type: 'thinking_start'; id: string }
  /** 思考链增量。端点不流式思考时不会有这个事件。 */
  | { type: 'thinking_delta'; id: string; text: string }
  /** 思考结束。content 是全文，消费端应整体替换而不是拼接。 */
  | { type: 'thinking_end'; id: string; content: string }
  | { type: 'tool_start'; name: string; id: string; args: Record<string, unknown> }
  | { type: 'tool_end'; name: string; id: string; ok: boolean; content: string }
  | { type: 'ask'; id: string; tool: string; detail: string }
  /** cachedTokens 仅在端点上报缓存用量时出现；costUsd 仅在模型声明了单价时出现。 */
  | { type: 'usage'; promptTokens: number; completionTokens: number; cachedTokens?: number; costUsd?: number }
  | { type: 'error'; text: string }
  /**
   * 压缩把后续轮次挪到一个新会话。
   *
   * 旧会话的消息原样留下，发送前缀不改写；界面把当前会话换成 `sessionId`，
   * 进行中的这一轮不重放转录。
   */
  | { type: 'session_fork'; sessionId: string; fromSessionId: string; covered: number }
  /**
   * 子任务块开始。toolCallId 是主流程里那次 subagent 工具调用的 id，
   * 恢复会话时靠它把块对齐回放流里的工具行。
   */
  | {
      type: 'subagent_start';
      id: string;
      description: string;
      mode: 'foreground' | 'background';
      /** 子代理定义的名字（内置为 explore / general，也可以是一份 agent 文件）。 */
      childType: string;
      childSessionId: string;
      toolCallId?: string;
      /** 子代理跑在隔离 git 工作树时的路径。 */
      worktree?: string;
    }
  /** 子代理的内部事件。消费端按 id 路由，不进主流程的步骤块。 */
  | { type: 'subagent_event'; id: string; event: SubagentEvent }
  /**
   * 子任务块结束。summary 是最终报告；ok=false 时 summary 是错误信息。
   * tokens 含嵌套后代的用量。
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

/** 先交给界面或 headless，再交给插件订阅者。某个订阅者抛错不影响其余。 */
export function combineListeners(primary: AgentListener, extra: readonly AgentListener[]): AgentListener {
  return (event) => {
    primary(event);
    for (const listener of extra) {
      try {
        listener(event);
      } catch {
        // 订阅者是旁路，不能打断这一轮。
      }
    }
  };
}
