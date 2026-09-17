import type { LlmClient, ChatMessage, TokenUsage } from '../llm/openai.js';
import type { SessionMessage } from '../session/types.js';
import { parseSessionLine, type JsonlSession } from '../session/store.js';

/** 最近 K 轮原文不动。一轮 = 一对 user/assistant（含其间 tool）。 */
const KEEP_RECENT_TURNS = 4;
/** 触发压缩的水位线。 */
const PRESSURE_RATIO = 0.8;
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
  '## Key Technical Concepts',
  '- [languages, frameworks, patterns, and conventions in play]',
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
 * 粗算 token：UTF-8 字节 / 4。只对初次见到的消息做 JSON.stringify，其余走缓存。
 * 用字节而不是 JS 字符，避免中文系统性低估、压缩触发偏晚。
 *
 * 导出给 recap 的只读预算复用：两边必须用同一把尺子，否则「估算不超窗」
 * 与「provider 不判超窗」会漂移。
 */
export function estimateTokens(messages: readonly ChatMessage[]): number {
  let bytes = 0;
  for (const message of messages) {
    let size = messageSizeCache.get(message);
    if (size === undefined) {
      size = Buffer.byteLength(JSON.stringify(message), 'utf8');
      messageSizeCache.set(message, size);
    }
    bytes += size;
  }
  return Math.ceil(bytes / 4);
}

/** 整数水位：`tokens * 100 >= window * 80`，避免 float 在 80% 边界漂移。 */
export function isOverPressure(tokens: number, contextWindow: number): boolean {
  return tokens * 100 >= contextWindow * Math.round(PRESSURE_RATIO * 100);
}

export interface ProjectionResult {
  messages: ChatMessage[];
  /** 压缩后的最新状态；loop 负责持久化为 compaction event 并在内存中续用。 */
  compaction?: CompactionEvent;
  /**
   * 本次投影实际应用的 stub 边界（session 坐标，readMessages 序）。
   * 仅在 stub 级真正生效且调用方未提供冻结值时回报——loop 首次拿到就冻结，
   * stub 窗口便不再随轮次前移（每前移一格，历史中段改写一次，缓存从切点起全部作废）。
   */
  stubbedFromSession?: number;
}

export interface CompactionEvent {
  summary: string;
  /** 已被摘要覆盖的 message 条数（readMessages 序，append-only 所以稳定）。 */
  covered: number;
}

const STUB_HEAD = 500;
const STUB_TAIL = 300;

function stubTool(message: ChatMessage): ChatMessage {
  const text = message.content;
  if (text.length <= STUB_HEAD + STUB_TAIL) return message;
  const pathLine = /^(wrote|updated|file)[^\n]*/.exec(text)?.[0];
  const exit = /exit (-?\d+|timeout)/.exec(text);
  const header = [
    '[compacted tool result]',
    pathLine,
    exit ? `exit ${exit[1]}` : '',
    `${text.length} chars; head/tail kept, middle dropped.`,
  ].filter(Boolean).join(' ');
  return {
    ...message,
    content: `${header}\n${text.slice(0, STUB_HEAD)}\n...\n${text.slice(-STUB_TAIL)}`,
  };
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

/**
 * 切点不能落在 assistant(tool_calls) 与其 tool result 之间。
 * 若 cut 落在 tool 消息上，滑回开启这一轮工具的 assistant，整段留在「最近」侧。
 */
export function pairingBalancedCut(messages: readonly ChatMessage[], cut: number): number {
  if (cut <= 0 || cut >= messages.length) return cut;
  if (messages[cut]?.role !== 'tool') return cut;
  let i = cut;
  while (i > 0 && messages[i - 1]?.role === 'tool') i--;
  if (i > 0 && messages[i - 1]?.role === 'assistant' && (messages[i - 1].tool_calls?.length ?? 0) > 0) {
    return i - 1;
  }
  return i;
}

function keepFromIndex(messages: ChatMessage[], emptyFallback: number): number {
  const starts = turnStarts(messages);
  const raw = starts.length > KEEP_RECENT_TURNS ? starts[starts.length - KEEP_RECENT_TURNS] : emptyFallback;
  return pairingBalancedCut(messages, raw);
}

/**
 * session 索引 → base 索引。base =（covered > 0 时）摘要消息 ++ messages.slice(covered)，
 * 其余一一对应，所以换算只有这一个偏移。
 */
function baseIndexOfSession(sessionIndex: number, compaction: CompactionEvent | undefined): number {
  const covered = compaction?.covered ?? 0;
  if (covered === 0) return sessionIndex;
  // 冻结值落在已被摘要覆盖的范围里：摘要本身就是新系列的边界，旧冻结作废。
  // loop 在摘要落地时也会重置它，这里只是防御。
  if (sessionIndex < covered) return -1;
  return sessionIndex - covered + 1;
}

/** base 索引 → session 索引（回报冻结值用）。 */
function sessionIndexOfBase(baseIndex: number, messagesLength: number, compaction: CompactionEvent | undefined): number {
  const covered = compaction?.covered ?? 0;
  if (covered === 0) return Math.min(baseIndex, messagesLength);
  if (baseIndex <= 0) return covered;
  return Math.min(baseIndex - 1 + covered, messagesLength);
}

/** 机械压缩：先戳旧 tool result，再把更旧的轮次收成字符串拼接摘要。纯同步、零成本，做 fallback。 */
function compactMessages(messages: ChatMessage[], contextWindow: number, force = false): ChatMessage[] {
  if (messages.length === 0) return messages;
  const limit = Math.floor(contextWindow * PRESSURE_RATIO);
  // 不做整表浅拷贝：identity 保持不变才能命中 estimateTokens 的缓存，
  // 且后续 stubTool 本来就返回新对象，不需要预先复制一遍。
  let next: ChatMessage[] = messages;
  if (!force && !isOverPressure(estimateTokens(next), contextWindow)) return next;

  const keepFrom = keepFromIndex(next, 0);
  // 只戳 tool 结果 —— 这一点与 projectContext 的第一级压缩保持一致。
  // 旧实现漏了 role === 'tool' 判断，把窗口外的 user/assistant 正文也一并替换成
  // "[compacted tool result]"，而摘要正是从这批消息生成的：结果是摘要内容全被抹平，
  // 历史信息彻底丢失（且摘要文本里出现的 [compacted tool result] 纯属噪声）。
  next = stubOldTools(next, keepFrom);
  if (!force && !isOverPressure(estimateTokens(next), contextWindow)) return next;

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
 * 增量 wire 投影。loop 每步只 push 新消息；compaction.covered 变化时才全量重建。
 * 工具图挂在连续 tool 段之后一条 user 上（OpenAI 的 tool 消息不能带图），所以
 * pendingImages 必须跨 push 存活，发请求前再 flush。
 */
export interface WireState {
  messages: ChatMessage[];
  pendingImages: string[];
}

export function emptyWire(compaction?: CompactionEvent): WireState {
  const messages: ChatMessage[] = [];
  if (compaction && compaction.covered > 0) {
    messages.push({
      role: 'user',
      content: `[compacted earlier context]\n${CHECKPOINT_PREAMBLE}\n\n${compaction.summary}`,
    });
  }
  return { messages, pendingImages: [] };
}

export function flushWireImages(state: WireState): void {
  if (state.pendingImages.length === 0) return;
  state.messages.push({
    role: 'user',
    content: '[tool result image]',
    parts: state.pendingImages.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
  });
  state.pendingImages = [];
}

export function pushSessionMessage(state: WireState, row: SessionMessage): void {
  if (row.role === 'tool') {
    if (row.images) state.pendingImages.push(...row.images);
    state.messages.push({
      role: 'tool',
      content: row.content,
      tool_call_id: row.toolCallId,
      name: row.toolName,
    });
    return;
  }
  flushWireImages(state);
  if (row.role === 'assistant' && row.toolCalls && row.toolCalls.length > 0) {
    state.messages.push({
      role: 'assistant',
      content: row.content,
      tool_calls: row.toolCalls.map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
      ...(row.reasoning?.length ? { reasoning: row.reasoning } : {}),
    });
    return;
  }
  if (row.role === 'system') return;
  const message: ChatMessage = { role: row.role, content: row.content };
  if (row.images && row.images.length > 0 && row.role === 'user') {
    message.parts = row.images.map((url) => ({ type: 'image_url' as const, image_url: { url } }));
  }
  if (row.role === 'assistant' && row.reasoning?.length) message.reasoning = row.reasoning;
  state.messages.push(message);
}

export function wireFromMessages(messages: readonly SessionMessage[], compaction?: CompactionEvent): WireState {
  const state = emptyWire(compaction);
  const from = compaction?.covered ?? 0;
  for (const row of messages.slice(from)) pushSessionMessage(state, row);
  flushWireImages(state);
  return state;
}

/**
 * session 记录 → wire 消息。
 *
 * 导出给 recap 复用：recap 的前缀必须与主轮次逐字一致，缓存才命中，
 * 所以投影这一步不允许有第二份实现。
 */
export function toChatMessages(messages: SessionMessage[], compaction?: CompactionEvent): ChatMessage[] {
  return wireFromMessages(messages, compaction).messages;
}

async function summarize(
  client: LlmClient,
  prefix: ChatMessage[],
  tools: unknown[],
  signal?: AbortSignal,
  onUsage?: (usage: TokenUsage) => void,
): Promise<string> {
  // 对齐 dsh：压缩走对话前缀（system + 历史），指令垫在最后一条 user，吃 KV 缓存。
  const reply = await client.complete(
    [...prefix, { role: 'user', content: COMPACTION_SYSTEM }],
    tools,
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
  /** 已投影的未 stub wire；省略则从 messages 重建。调用方须先 flush 图片。 */
  base?: ChatMessage[];
  /**
   * 调用方冻结的 stub 边界（session 坐标，readMessages 序）。
   *
   * 不传时按「最近 K 轮完好」现算——那个窗口每加一轮就前移一格，历史中段随之改写一次，
   * 缓存从切点起全部作废。传入后 stub 级固定从这条边界起保留原文，窗口只增不滑；
   * 窗口因此涨大也无妨，水位线会照常触发 LLM 摘要，摘要才是真正的系列边界。
   */
  stubFromSession?: number;
  /** 主轮工具表；压缩请求带上才能与上一跳共享前缀。 */
  tools?: unknown[];
}): Promise<ProjectionResult> {
  const { messages, contextWindow, client, signal } = options;
  const compaction = options.compaction;
  const withSystem = (list: ChatMessage[]): ChatMessage[] =>
    options.system ? [{ role: 'system', content: options.system }, ...list] : list;
  const base = options.base ?? toChatMessages(messages, compaction);
  const limit = Math.floor(contextWindow * PRESSURE_RATIO);
  const tokens = estimatePromptTokens(base, messages, options.lastUsage, options.lastUsageAnchor);
  const force = options.force === true;
  if (messages.length === 0 || (!force && !isOverPressure(tokens, contextWindow))) {
    return { messages: withSystem(base) };
  }

  // 第一级：stub 全部旧 tool result（含摘要覆盖范围内的），零成本。
  // 冻结边界优先：它由 loop 在首次 stub 时回报并固定，坐标换算见 baseIndexOfSession。
  const frozen = options.stubFromSession === undefined
    ? undefined
    : baseIndexOfSession(options.stubFromSession, compaction);
  const keepFrom = frozen !== undefined && frozen >= 0 ? frozen : keepFromIndex(base, base.length);
  const stubbed = stubOldTools(base, keepFrom, true);
  // 只估算一次：stub 后仍超水位线时才继续走 LLM 摘要。force 时不能提前返回——
  // provider 的判定优先于我们自己的估算，否则会原样重发同一个必然失败的请求。
  if (!force && !isOverPressure(estimateTokens(stubbed), contextWindow)) {
    return {
      messages: withSystem(stubbed),
      // 只在首次（调用方还没冻结）且真的 stub 掉了内容时回报；空转的边界不值得冻结。
      ...(options.stubFromSession === undefined && keepFrom < base.length
        ? { stubbedFromSession: sessionIndexOfBase(keepFrom, messages.length, compaction) }
        : {}),
    };
  }

  // 第二级：LLM 摘要。范围 = 已摘要覆盖之后、保留窗口之前的原始记录。
  const keepOriginal = messages.length > KEEP_RECENT_TURNS * 2 ? messages.length - KEEP_RECENT_TURNS * 2 : 0;
  const rangeFrom = compaction?.covered ?? 0;
  const range = messages.slice(rangeFrom, Math.max(rangeFrom, keepOriginal));
  if (range.length > 0 && range.some((row) => row.role !== 'system')) {
    try {
      const prefix = withSystem(toChatMessages(messages.slice(0, rangeFrom + range.length), compaction));
      const summary = await summarize(client, prefix, options.tools ?? [], signal, options.onUsage);
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
