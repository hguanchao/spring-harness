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
  /** 会话树节点 id；旧记录可缺。 */
  id?: string;
  parentId?: string | null;
}

/** 一次工具失败的折叠摘要。循环把它写进下一轮提示，避免恢复后重蹈覆辙。 */
export interface SessionFailure {
  tool: string;
  excerpt: string;
  ts: string;
}

/**
 * 用户以 @路径 提及的文件附件。content 保持用户消息原文（`@路径` 原样留在正文里），
 * 投影层负责把附件拼成模型可见的 `<attached-files>` 块——存储与展示都不受污染。
 */
export interface FileAttachment {
  /** 用户引用的路径（@token 内容，保持输入原样）。 */
  path: string;
  /** 文件内容；缺席表示读取失败，见 error。 */
  content?: string;
  /** 内容超过单文件上限被截断时的原始总字节数。 */
  totalBytes?: number;
  /** content 缺席时的失败原因（not found / outside workspace / directory / binary …）。 */
  error?: string;
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
  /** 文本形式的 @ 文件附件（FileAttachment）；只出现在 user 消息上。 */
  attachments?: FileAttachment[];
  /** Responses 推理项，下一轮原样回传；没有 encryptedContent 的项不要存。 */
  reasoning?: Array<{ id: string; encryptedContent?: string; summary?: string }>;
  /**
   * Anthropic thinking 块回放载荷：思考明文 + 签名（signature_delta 累积）。
   * 官方 API 在 thinking 启用时要求含 tool_use 的 assistant 消息以 thinking 块开头；
   * 只有签名（明文被网关剥掉）时按 redacted_thinking 回传。
   */
  thinking?: string;
  thinkingSignature?: string;
  id?: string;
  parentId?: string | null;
}

export type SessionRecord = SessionEvent | SessionMessage;

/**
 * 会话存储端口。loop / repair / compact / export 只依赖这一面；
 * 默认实现是 JSONL，测试可换成内存表。
 */
export interface SessionPort {
  readonly id: string;
  readonly dir: string;
  append(record: SessionRecord): void;
  appendMessage(message: Omit<SessionMessage, 'type' | 'ts'>): void;
  appendEvent(kind: string, data: Record<string, unknown>): void;
  readAll(): SessionRecord[];
  readMessages(): SessionMessage[];
  /** 当前分支头。旧线性会话可缺。 */
  readonly tip?: string;
  setTip?(id: string): void;
  /** 当前分支上的记录。没有会话树的实现可以不提供，调用方退回 readAll。 */
  readPath?(): SessionRecord[];
}

export interface SessionFactory {
  create(dir: string, workspaceRoot: string, makeCurrent?: boolean): SessionPort;
  open(dir: string, id: string): SessionPort;
  resumeOrCreate(dir: string, workspaceRoot: string, forceNew: boolean): Promise<SessionPort>;
}
