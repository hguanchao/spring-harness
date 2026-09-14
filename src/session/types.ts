export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface SessionEvent {
  type: 'event';
  ts: string;
  kind: string;
  data: Record<string, unknown>;
}

export interface SessionMessage {
  type: 'message';
  ts: string;
  role: Role;
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: ToolCall[];
  /** data URL 形式的图片附件（用户输入的 @图片 或 read_file 读到的图片）。 */
  images?: string[];
}

export type SessionRecord = SessionEvent | SessionMessage;
