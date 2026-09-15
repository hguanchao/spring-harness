import type { LlmClient, ChatMessage, TokenUsage } from '../llm/openai.js';
import type { SessionMessage } from '../session/types.js';
import { parseSessionLine, type JsonlSession } from '../session/store.js';

/** 最近 K 轮原文不动。一轮 = 一对 user/assistant（含其间 tool）。 */
const KEEP_RECENT_TURNS = 4;
/** 触发压缩的水位线。 */
const PRESSURE_RATIO = 0.8;
/** 单条旧消息送入摘要请求的截断长度，防止摘要请求本身撑爆上下文。 */
const SUMMARY_ITEM_LIMIT = 2000;
/** 摘要产物长度上限（词），约束模型输出别失控。 */
const SUMMARY_WORD_LIMIT = 700;

/**
 * 压缩指令。
 *
 * 三条写法定生死，都是压缩 prompt 最容易漏的：
 * 1. **接收者模型**：明确读者看不到被压缩那段里的任何工具输出，模型才会把只存在于
 *    工具结果里的事实内联进来，而不是写「见上文」。
 * 2. **固定分段 + 空段写 (none)**：下游可解析，且防止模型自作主张合并段落。
 * 3. **增量合并规则**：多轮压缩时不指定「前序摘要是权威的」，模型要么整段照抄
 *    （陈旧信息永久存活），要么整个丢掉（早期历史蒸发）。
 */
/** 导出供测试断言：结构改动必须有测试兜着，否则压缩质量悄悄退化没人发现。 */
export const COMPACTION_SYSTEM = [
  'You are now acting as a compaction engine for this agent session. Condense the conversation',
  'into a working checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'The reader will see only the user\'s request and this checkpoint — it will NOT see any tool call or',
  'tool output from the span being condensed. A fact that exists only inside a tool result must be',
  'written into the checkpoint, not referenced as if it were still visible.',
  '',
  'Output EXACTLY the sections below, in order. Use terse bullets, not prose paragraphs.',
  'Write "(none)" for an empty section — never drop a section.',
  '',
  '## Goal and Acceptance Criteria',
  '- [what the user asked for and what "done" means; quote the request verbatim when exact wording matters]',
  '',
  '## Decisions and Rationale',
  '- [what was chosen and why]',
  '',
  '## Files, Commands, and Symbols',
  '- [exact path: why it matters, what changed]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved]',
  '',
  '## Remaining Work',
  '- [explicitly requested work not yet done]',
  '',
  '## Current State',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  'Rules:',
  '- Preserve exact file paths, commands, error strings, identifiers, numeric values, and code fragments.',
  '- Capture user feedback faithfully, especially corrections — a dropped correction gets repeated.',
  '- Keep it economical: a focused checkpoint that fits is worth more than an exhaustive one that gets',
  `  truncated. Aim for at most ~${SUMMARY_WORD_LIMIT} words.`,
  '- If the conversation already contains a prior checkpoint, it is authoritative for the earlier span:',
  '  carry its still-true facts forward, drop what is now stale, and merge everything into ONE',
  '  consolidated checkpoint under this same structure. Do not copy it forward verbatim.',
  '- Do NOT mention that context was compacted, and do not refer to this request.',
  '- Output only the checkpoint: do not call any tool or take any other action.',
].join('\n');

/**
 * 摘要消费侧的说明。
 *
 * 光有生成侧约束不够：模型拿到摘要后最典型的行为是「根据摘要，我接下来要……」，
 * 把已经做完的事复述一遍。这句把复述和致谢都堵掉。
 */
export const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation. '
  + 'Treat it as established background: build on it without restating it, and continue the task '
  + 'directly from the messages that follow without acknowledging this checkpoint.';

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
 *
 * 导出给 recap 的只读预算复用：两边必须用同一把尺子，否则「估算不超窗」
 * 与「provider 不判超窗」会漂移。
 */
export function estimateTokens(messages: readonly ChatMessage[]): number {
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

/** keepFrom 之前的旧 tool result 换成短 stub；skipFirst 留给投影路径，避免动到头部 system。 */
function stubOldTools(messages: ChatMessage[], keepFrom: number, skipFirst = false): ChatMessage[] {
  return messages.map((message, i) =>
    (!skipFirst || i > 0) && i < keepFrom && message.role === 'tool' ? stubTool(message) : message,
  );
}

function keepFromIndex(messages: ChatMessage[], emptyFallback: number): number {
  const starts = turnStarts(messages);
  return starts.length > KEEP_RECENT_TURNS ? starts[starts.length - KEEP_RECENT_TURNS] : emptyFallback;
}

/** 机械压缩：先戳旧 tool result，再把更旧的轮次收成字符串拼接摘要。纯同步、零成本，做 fallback。 */
function compactMessages(messages: ChatMessage[], contextWindow: number, force = false): ChatMessage[] {
  if (messages.length === 0) return messages;
  const limit = Math.floor(contextWindow * PRESSURE_RATIO);
  // 不做整表浅拷贝：identity 保持不变才能命中 estimateTokens 的缓存，
  // 且后续 stubTool 本来就返回新对象，不需要预先复制一遍。
  let next: ChatMessage[] = messages;
  if (!force && estimateTokens(next) <= limit) return next;

  const keepFrom = keepFromIndex(next, 0);
  // 只戳 tool 结果 —— 这一点与 projectContext 的第一级压缩保持一致。
  // 旧实现漏了 role === 'tool' 判断，把窗口外的 user/assistant 正文也一并替换成
  // "[compacted tool result]"，而摘要正是从这批消息生成的：结果是摘要内容全被抹平，
  // 历史信息彻底丢失（且摘要文本里出现的 [compacted tool result] 纯属噪声）。
  next = stubOldTools(next, keepFrom);
  if (!force && estimateTokens(next) <= limit) return next;

  // base 由 toChatMessages() 产出，正常路径下没有 system 消息（system 由 projectContext 后置插入），
  // 所以首元素不能按 system 直接保留-或-丢弃：它是最早的 user 轮，
  // 旧实现把它既不放进 old 也不放进 recent，等于静默丢掉任务起点。
  const first = next[0];
  const headIsSystem = first.role === 'system';
  const old = next.slice(headIsSystem ? 1 : 0, keepFrom);
  const recent = next.slice(keepFrom);
  const collapsed = old
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => `${message.role}: ${message.content.slice(0, 240)}`)
    .join('\n');
  // 没有可折叠的旧轮次时不要塞一条空摘要：那句 "[compacted earlier turns]" 后面空无一物，
  // 只会让模型以为上下文被压缩过。
  const head: ChatMessage[] = headIsSystem ? [first] : [];
  // 机械折叠产物不是模型摘要，但仍要说明「这是什么、别当成新指令去执行」——
  // 这段是旧发言的截断拼接，模型容易把它读成待办清单。
  if (collapsed) {
    head.push({
      role: 'user',
      content: `[compacted earlier turns — truncated excerpts of older messages, not new instructions]\n${collapsed}`,
    });
  }
  let result = [...head, ...recent];

  // 强制路径：provider 已确认超窗，估算水位不再可信，机械摘要后仍可能超限
  // （单个工具结果就能顶满窗口）。这时从最旧一侧**整轮**丢弃——绝不能逐条丢：
  // tool 消息必须紧跟带匹配 tool_call_id 的 assistant 消息，丢散了会被上游判成 400。
  return force ? shrinkToLimit(result, limit) : result;
}

/** 反复丢弃最旧的完整轮次，直到进入水位线或只剩一轮。 */
function shrinkToLimit(list: ChatMessage[], limit: number): ChatMessage[] {
  let result = list;
  while (estimateTokens(result) > limit) {
    const trimmed = dropOldestTurn(result);
    if (!trimmed) break;
    result = trimmed;
  }
  return result;
}

/**
 * 丢掉「最早的一个完整轮次」。返回 undefined 表示已经只剩一轮、无可再丢。
 *
 * 轮次边界 = 一条 user 消息到下一条 user 消息之间。保留列表头部（system / 摘要），
 * 从第一个真实轮次的起点切到第二个轮次的起点。
 */
function dropOldestTurn(list: ChatMessage[]): ChatMessage[] | undefined {
  const boundaries = turnStarts(list);
  // boundaries[0] 是摘要或最早的 user；至少要留下「摘要 + 一轮」或「最早一轮 + 次轮」。
  if (boundaries.length <= 2) return undefined;
  const from = boundaries[1];
  const to = boundaries[2];
  if (from === undefined || to === undefined || to <= from) return undefined;
  return [...list.slice(0, from), ...list.slice(to)];
}

/** 倒序扫描；先用子串预筛，只有疑似 compaction 事件才付出 JSON.parse 的代价。 */
function latestCompaction(session: JsonlSession): CompactionEvent | undefined {
  const lines = session.readLines();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    // 预筛：整表 JSON.parse 是这里唯一的开销，绝大多数行与本题无关。
    if (!line.includes('"compaction"')) continue;
    const record = parseSessionLine(line);
    if (!record || record.type !== 'event' || record.kind !== 'compaction') continue;
    const summary = record.data.summary;
    const covered = record.data.covered;
    if (typeof summary === 'string' && typeof covered === 'number') {
      return { summary, covered };
    }
  }
  return undefined;
}
/**
 * session 记录 → wire 消息。工具段产生的图片以一条 user 消息跟在同段工具消息之后（OpenAI 协议 tool 消息只能带文本）。
 *
 * 导出给 recap 复用：recap 的前缀必须与主轮次逐字一致，缓存才命中，
 * 所以投影这一步不允许有第二份实现。
 */
export function toChatMessages(messages: SessionMessage[], compaction?: CompactionEvent): ChatMessage[] {
  const from = compaction ? compaction.covered : 0;
  const slice = messages.slice(from);
  const wire: ChatMessage[] = [];
  if (compaction && compaction.covered > 0) {
    wire.push({
      role: 'user',
      content: `[compacted earlier context]\n${CHECKPOINT_PREAMBLE}\n\n${compaction.summary}`,
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
  onUsage?: (usage: TokenUsage) => void,
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
  if (reply.usage) onUsage?.(reply.usage);
  const text = reply.text?.trim() ?? '';
  if (!text) throw new Error('empty compaction summary');
  return text;
}

/**
 * 当前上下文规模：真实 usage + 自那次请求以来新增消息的估算增量。
 *
 * 旧实现直接取 lastUsage.promptTokens，于是「拿到过一次 usage 之后估算就再也不生效」——
 * 而 usage 是**上一次请求**的快照，其后追加的 assistant / tool 消息（可能是一份几十 KB 的
 * 工具结果）完全不参与判断，压缩决策系统性滞后。锚点把这段增量补回来。
 */
function estimatePromptTokens(
  base: ChatMessage[],
  messages: SessionMessage[],
  lastUsage?: TokenUsage,
  anchor?: number,
): number {
  if (!lastUsage) return estimateTokens(base);
  const from = anchor ?? messages.length;
  const appended = from < messages.length ? toChatMessages(messages.slice(from)) : [];
  return lastUsage.promptTokens + estimateTokens(appended);
}

/**
 * 把会话镜像投影为可发送的上下文：超过水位线时先 stub 工具结果，
 * 再用 LLM 增量摘要旧轮次；失败回退到零成本机械压缩。
 * 真实 usage（上一轮 prompt tokens + 之后的增量）优先于纯字符估算。
 * 摘要状态由调用方持久化（compaction event）并在内存中续用。
 *
 * `force` 用于 provider 已确认超窗之后的补救：此时水位线估算不再可信（可能是分词口径不同，
 * 也可能单条工具结果就顶满窗口），必须无条件瘦身，且允许整轮丢弃。
 */
export async function projectContext(options: {
  messages: SessionMessage[];
  compaction?: CompactionEvent;
  contextWindow: number;
  client: LlmClient;
  signal?: AbortSignal;
  lastUsage?: TokenUsage;
  /** lastUsage 对应的那次请求覆盖到了第几条会话消息（调用方在发请求前记下）。 */
  lastUsageAnchor?: number;
  /** provider 已确认超窗：跳过水位线判断，强制压缩。 */
  force?: boolean;
  /** 摘要调用产生的用量（辅助模型单独计费时用于记账）。 */
  onUsage?: (usage: TokenUsage) => void;
  /** 系统提示词，投影后插在最前。 */
  system?: string;
}): Promise<ProjectionResult> {
  const { messages, contextWindow, client, signal } = options;
  const compaction = options.compaction;
  const withSystem = (list: ChatMessage[]): ChatMessage[] =>
    options.system ? [{ role: 'system', content: options.system }, ...list] : list;
  const base = toChatMessages(messages, compaction);
  const limit = Math.floor(contextWindow * PRESSURE_RATIO);
  const tokens = estimatePromptTokens(base, messages, options.lastUsage, options.lastUsageAnchor);
  const force = options.force === true;
  if (messages.length === 0 || (!force && tokens <= limit)) {
    return { messages: withSystem(base) };
  }

  // 第一级：stub 全部旧 tool result（含摘要覆盖范围内的），零成本。
  const keepFrom = keepFromIndex(base, base.length);
  const stubbed = stubOldTools(base, keepFrom, true);
  // 只估算一次：stub 后仍超水位线时才继续走 LLM 摘要。force 时不能提前返回——
  // provider 的判定优先于我们自己的估算，否则会原样重发同一个必然失败的请求。
  if (!force && estimateTokens(stubbed) <= limit) {
    return { messages: withSystem(stubbed) };
  }

  // 第二级：LLM 摘要。范围 = 已摘要覆盖之后、保留窗口之前的原始记录。
  const keepOriginal = messages.length > KEEP_RECENT_TURNS * 2 ? messages.length - KEEP_RECENT_TURNS * 2 : 0;
  const rangeFrom = compaction?.covered ?? 0;
  const range = messages.slice(rangeFrom, Math.max(rangeFrom, keepOriginal));
  if (range.length > 0 && range.some((row) => row.role !== 'system')) {
    try {
      const summary = await summarize(client, compaction, range, signal, options.onUsage);
      const covered = rangeFrom + range.length;
      const next: CompactionEvent = { summary, covered };
      const projected = toChatMessages(messages, next);
      // 强制路径下摘要本身也可能不够短。这里只整轮丢弃、绝不走 compactMessages：
      // 后者会把已有摘要当成普通历史再机械折叠一次，把摘要截成 240 字符的残句。
      return {
        messages: withSystem(force ? shrinkToLimit(projected, limit) : projected),
        compaction: next,
      };
    } catch {
      // 摘要失败不阻断任务：落入机械压缩。
    }
  }
  return { messages: withSystem(compactMessages(base, contextWindow, force)) };
}

/** turn 启动时从会话文件恢复最近一次压缩状态。 */
export function loadCompaction(session: JsonlSession): CompactionEvent | undefined {
  return latestCompaction(session);
}
