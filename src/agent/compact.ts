import type { LlmClient, ChatMessage, TokenUsage } from '../llm/openai.js';
import type { SessionMessage, SessionRecord } from '../session/types.js';
import type { JsonlSession } from '../session/store.js';

/** 最近 K 轮原文不动。一轮 = 一对 user/assistant（含其间 tool）。 */
const KEEP_RECENT_TURNS = 4;
/** 触发压缩的水位线。 */
const PRESSURE_RATIO = 0.8;
/** 单条旧消息送入摘要请求的截断长度，防止摘要请求本身撑爆上下文。 */
const SUMMARY_ITEM_LIMIT = 2000;
/** 摘要产物长度上限（词），约束模型输出别失控。 */
const SUMMARY_WORD_LIMIT = 700;

const COMPACTION_SYSTEM = [
  'You compress an agent conversation history into a compact working summary.',
  'Preserve, in this priority: the active task goal and acceptance criteria; decisions made and why;',
  'file paths, commands and code symbols already touched; errors hit and their fixes; what remains undone.',
  'Drop pleasantries and redundant tool output. Write at most ~' + SUMMARY_WORD_LIMIT + ' words.',
  'Output the summary only, as terse bullet lines.',
].join(' ');

/**
 * 单条消息的序列化长度缓存。
 * 消息对象在本模块内从不原地修改（改写一律走 `{ ...message }` 造新对象），
 * 因此可以按对象引用缓存，命中即跳过 JSON.stringify。
 */
const messageSizeCache = new WeakMap<ChatMessage, number>();

/**
 * 粗算 token：只对初次见到的消息做 JSON.stringify，其余走缓存。
 * 旧实现对整个上下文重复 stringify——一个 turn 内最多触发 4 次
 * （projectContext 两次 + compactMessages 两次），长会话下是纯 CPU 浪费。
 */
function estimateTokens(messages: readonly ChatMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    let size = messageSizeCache.get(message);
    if (size === undefined) {
      size = JSON.stringify(message).length;
      messageSizeCache.set(message, size);
    }
    chars += size;
  }
  return Math.ceil(chars / 4);
}

export interface ProjectionResult {
  messages: ChatMessage[];
  /** 压缩后的最新状态；loop 负责持久化为 compaction event 并在内存中续用。 */
  compaction?: CompactionEvent;
}

export interface CompactionEvent {
  summary: string;
  /** 已被摘要覆盖的 message 条数（readMessages 序，append-only 所以稳定）。 */
  covered: number;
}

function stubTool(message: ChatMessage): ChatMessage {
  const match = /exit (-?\d+|timeout)/.exec(message.content);
  const pathMatch = /^(wrote|updated|file)[^\n]*/.exec(message.content);
  const stub = [
    '[compacted tool result]',
    pathMatch?.[0] ?? '',
    match ? `exit ${match[1]}` : '',
  ].filter(Boolean).join(' ');
  return { ...message, content: stub || '[compacted tool result]' };
}

function turnStarts(messages: ChatMessage[]): number[] {
  const starts: number[] = [];
  messages.forEach((message, i) => {
    if (message.role === 'user') starts.push(i);
  });
  return starts;
}

/** 机械压缩：先戳旧 tool result，再把更旧的轮次收成字符串拼接摘要。纯同步、零成本，做 fallback。 */
function compactMessages(messages: ChatMessage[], contextWindow: number): ChatMessage[] {
  if (messages.length === 0) return messages;
  const limit = Math.floor(contextWindow * PRESSURE_RATIO);
  // 不做整表浅拷贝：identity 保持不变才能命中 estimateTokens 的缓存，
  // 且后续 stubTool 本来就返回新对象，不需要预先复制一遍。
  let next: ChatMessage[] = messages;
  if (estimateTokens(next) <= limit) return next;

  const starts = turnStarts(next);
  const keepFrom = starts.length > KEEP_RECENT_TURNS ? starts[starts.length - KEEP_RECENT_TURNS] : 0;
  // 只戳 tool 结果 —— 这一点与 projectContext 的第一级压缩保持一致。
  // 旧实现漏了 role === 'tool' 判断，把窗口外的 user/assistant 正文也一并替换成
  // "[compacted tool result]"，而摘要正是从这批消息生成的：结果是摘要内容全被抹平，
  // 历史信息彻底丢失（且摘要文本里出现的 [compacted tool result] 纯属噪声）。
  next = next.map((message, i) => (i < keepFrom && message.role === 'tool' ? stubTool(message) : message));
  if (estimateTokens(next) <= limit) return next;

  // base 由 toChatMessages() 产出，正常路径下没有 system 消息（system 由 projectContext 后置插入），
  // 所以首元素不能按 system 直接保留-或-丢弃：它是最早的 user 轮，
  // 旧实现把它既不放进 old 也不放进 recent，等于静默丢掉任务起点。
  const first = next[0];
  const headIsSystem = first.role === 'system';
  const old = next.slice(headIsSystem ? 1 : 0, keepFrom);
  const recent = next.slice(keepFrom);
  const summary: ChatMessage = {
    role: 'user',
    content: `[compacted earlier turns]\n${old
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => `${message.role}: ${message.content.slice(0, 240)}`)
      .join('\n')}`,
  };
  return headIsSystem ? [first, summary, ...recent] : [summary, ...recent];
}

/** 倒序扫描；先用子串预筛，只有疑似 compaction 事件才付出 JSON.parse 的代价。 */
function latestCompaction(session: JsonlSession): CompactionEvent | undefined {
  const lines = session.readLines();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    // 预筛：整表 JSON.parse 是这里唯一的开销，绝大多数行与本题无关。
    if (!line.includes('"compaction"')) continue;
    let record: SessionRecord;
    try {
      record = JSON.parse(line) as SessionRecord;
    } catch {
      continue;
    }
    if (record.type !== 'event' || record.kind !== 'compaction') continue;
    const summary = record.data.summary;
    const covered = record.data.covered;
    if (typeof summary === 'string' && typeof covered === 'number') {
      return { summary, covered };
    }
  }
  return undefined;
}
/** session 记录 → wire 消息。工具段产生的图片以一条 user 消息跟在同段工具消息之后（OpenAI 协议 tool 消息只能带文本）。 */
function toChatMessages(messages: SessionMessage[], compaction?: CompactionEvent): ChatMessage[] {
  const from = compaction ? compaction.covered : 0;
  const slice = messages.slice(from);
  const wire: ChatMessage[] = [];
  if (compaction && compaction.covered > 0) {
    wire.push({
      role: 'user',
      content: `[compacted earlier context]\n${compaction.summary}`,
    });
  }
  let pendingImages: string[] = [];
  const flushImages = (): void => {
    if (pendingImages.length === 0) return;
    wire.push({
      role: 'user',
      content: '[tool result image]',
      parts: pendingImages.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
    });
    pendingImages = [];
  };
  for (const row of slice) {
    if (row.role === 'tool') {
      if (row.images) pendingImages.push(...row.images);
      wire.push({
        role: 'tool',
        content: row.content,
        tool_call_id: row.toolCallId,
        name: row.toolName,
      });
      continue;
    }
    flushImages();
    if (row.role === 'assistant' && row.toolCalls && row.toolCalls.length > 0) {
      wire.push({
        role: 'assistant',
        content: row.content,
        tool_calls: row.toolCalls.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      });
      continue;
    }
    if (row.role === 'system') continue;
    const message: ChatMessage = { role: row.role, content: row.content };
    if (row.images && row.images.length > 0 && row.role === 'user') {
      message.parts = row.images.map((url) => ({ type: 'image_url' as const, image_url: { url } }));
    }
    wire.push(message);
  }
  flushImages();
  return wire;
}

async function summarize(
  client: LlmClient,
  previous: CompactionEvent | undefined,
  range: SessionMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const transcript = range
    .filter((row) => row.role !== 'system')
    .map((row) => `${row.role}: ${row.content.slice(0, SUMMARY_ITEM_LIMIT)}`)
    .join('\n');
  const body = [
    previous ? `Summary of even earlier turns:\n${previous.summary}` : '',
    `Newer turns to fold in:\n${transcript}`,
  ].filter(Boolean).join('\n\n');
  const reply = await client.complete(
    [
      { role: 'system', content: COMPACTION_SYSTEM },
      { role: 'user', content: body },
    ],
    [],
    signal,
  );
  const text = reply.text?.trim() ?? '';
  if (!text) throw new Error('empty compaction summary');
  return text;
}

/**
 * 把会话镜像投影为可发送的上下文：超过水位线时先 stub 工具结果，
 * 再用 LLM 增量摘要旧轮次；失败回退到零成本机械压缩。
 * 真实 usage（上一轮 prompt tokens）优先于字符估算。
 * 摘要状态由调用方持久化（compaction event）并在内存中续用。
 */
export async function projectContext(options: {
  messages: SessionMessage[];
  compaction?: CompactionEvent;
  contextWindow: number;
  client: LlmClient;
  signal?: AbortSignal;
  lastUsage?: TokenUsage;
  /** 系统提示词，投影后插在最前。 */
  system?: string;
}): Promise<ProjectionResult> {
  const { messages, contextWindow, client, signal } = options;
  const compaction = options.compaction;
  const withSystem = (list: ChatMessage[]): ChatMessage[] =>
    options.system ? [{ role: 'system', content: options.system }, ...list] : list;
  const base = toChatMessages(messages, compaction);
  const limit = Math.floor(contextWindow * PRESSURE_RATIO);
  const tokens = options.lastUsage?.promptTokens ?? estimateTokens(base);
  if (messages.length === 0 || tokens <= limit) {
    return { messages: withSystem(base) };
  }

  // 第一级：stub 全部旧 tool result（含摘要覆盖范围内的），零成本。
  const starts = turnStarts(base);
  const keepFrom = starts.length > KEEP_RECENT_TURNS ? starts[starts.length - KEEP_RECENT_TURNS] : base.length;
  const stubbed = base.map((message, i) =>
    i > 0 && i < keepFrom && message.role === 'tool' ? stubTool(message) : message,
  );
  // 只估算一次：stub 后仍超水位线时才继续走 LLM 摘要。
  if (estimateTokens(stubbed) <= limit) {
    return { messages: withSystem(stubbed) };
  }

  // 第二级：LLM 摘要。范围 = 已摘要覆盖之后、保留窗口之前的原始记录。
  const keepOriginal = messages.length > KEEP_RECENT_TURNS * 2 ? messages.length - KEEP_RECENT_TURNS * 2 : 0;
  const rangeFrom = compaction?.covered ?? 0;
  const range = messages.slice(rangeFrom, Math.max(rangeFrom, keepOriginal));
  if (range.length > 0 && range.some((row) => row.role !== 'system')) {
    try {
      const summary = await summarize(client, compaction, range, signal);
      const covered = rangeFrom + range.length;
      const next: CompactionEvent = { summary, covered };
      return { messages: withSystem(toChatMessages(messages, next)), compaction: next };
    } catch {
      // 摘要失败不阻断任务：落入机械压缩。
    }
  }
  return { messages: withSystem(compactMessages(base, contextWindow)) };
}

/** turn 启动时从会话文件恢复最近一次压缩状态。 */
export function loadCompaction(session: JsonlSession): CompactionEvent | undefined {
  return latestCompaction(session);
}
