/**
 * 提示缓存的命中观测。
 *
 * 为什么需要它：命中率不是靠感觉调的。前缀的每一次意外改动都表现为「本来该按缓存价读的
 * token 被按全价重算了一遍」，而 usage 里只有一个 `cachedTokens` 数字——单看它分不清
 * 「这一轮突然变差」和「一直就这么差」。这里把相邻两次请求拉平对比，把差值归因到具体的
 * token 数上，并在超过噪声下限时给出最可能的解释（等太久 TTL 过期 / 换了模型）。
 *
 * 口径：
 *
 *   missed = min(上一轮 promptTokens, 本轮 promptTokens) − cachedTokens
 *
 * 取 `min` 是因为提示词变短时，少掉的那部分本轮根本不在提示里，不该算成未命中。
 * `promptTokens` 在三个适配层已统一成**含缓存**的口径（见 llm/openai.ts 的 TokenUsage），
 * 所以这个式子在 chat-completions / responses / anthropic-messages 下含义一致。
 */

/**
 * Anthropic 的默认缓存 TTL。闲置超过它，整段缓存已经过期，下一轮必然整段重算。
 * OpenAI 的自动缓存是 5~10 分钟量级，同一个数量级，所以用它做统一提示阈值。
 */
export const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * 断点粒度造成的天然误差下限。
 *
 * 缓存按固定步长（Anthropic 128 token、OpenAI 1024 token）对齐，两次请求的断点位置不可能
 * 完全吻合，差值在步长以内属于正常抖动。低于这个数报出来只会变成噪声，把真正的问题淹掉。
 */
export const CACHE_NOISE_FLOOR = 1024;

export interface CacheSample {
  /** 含缓存的输入总量。 */
  promptTokens: number;
  /** 命中缓存的输入量；端点不上报时为 undefined（与「命中 0」是两回事）。 */
  cachedTokens?: number;
  /** 采样时刻（毫秒）；省略则无法归因闲置超时。 */
  at?: number;
  /** 模型身份，用于把「换了模型导致整段重算」单独标出来。 */
  modelKey?: string;
}

export interface CacheMiss {
  /** 上一轮在提示里、本轮却没从缓存读到的 token 数。 */
  missedTokens: number;
  /** 距上一次请求的毫秒数；大于 CACHE_TTL_MS 时 TTL 过期是最可能的解释。 */
  idleMs?: number;
  /** 相对上一次请求换了模型。这会整段重算，属于预期行为而非缺陷。 */
  modelChanged: boolean;
  /** 闲置已超过缓存 TTL。 */
  likelyExpired: boolean;
  /**
   * 这次未命中是预期的（换了模型，或压缩后改走新会话）。
   * 仍落事件，方便和「前缀被意外改写」分开，但不进 waste。
   */
  expected: boolean;
  /** expected 为真时的原因。普通未命中不填。 */
  reason?: 'model' | 'compaction';
}

export interface CacheWaste {
  /** 计入统计的请求数（每段的第一轮不计：那时没有可对比的基线）。 */
  requestCount: number;
  /** 累计输入 token（含缓存）。 */
  promptTokens: number;
  /** 累计命中缓存的输入 token。 */
  cachedTokens: number;
  /** 累计「本该命中却没命中」的 token（只累加超过噪声下限的那些）。 */
  missedTokens: number;
  /** 被计为一次未命中的次数。 */
  missCount: number;
}

const EMPTY_WASTE: CacheWaste = {
  requestCount: 0,
  promptTokens: 0,
  cachedTokens: 0,
  missedTokens: 0,
  missCount: 0,
};

/**
 * 增量式的未命中检测器。
 *
 * 一次 `runTurn` 用一个实例做实时提示；`foldSessionState` 用另一个实例按顺序重放会话里的
 * usage 事件，得到跨轮次的累计量。同一个口径两处复用——分别实现迟早会给出两个不同的数字，
 * 而那正是用户最没办法判断谁对的情况。
 */
export class CacheMissTracker {
  private previous?: CacheSample;
  /**
   * 下一次没有基线的采样按预期冷启动记，而不是静默丢掉。
   * 压缩新开会话之后，整段重算是新内容，不是前缀被改坏。
   */
  private coldStart?: 'compaction';
  /**
   * 粘性标记：这一段里是否见过缓存活动。
   *
   * 用来区分两件长得一样的事——「只上报缓存读的端点（OpenAI 系）整段未命中」与
   * 「这个端点根本不支持缓存」。后者报未命中纯属误报，会把用户引向不存在的优化。
   */
  private sawCacheActivity = false;
  private totals: CacheWaste = { ...EMPTY_WASTE };

  /**
   * 记一次请求。返回本次的未命中（低于噪声下限、或无法判定时返回 undefined）。
   */
  observe(sample: CacheSample): CacheMiss | undefined {
    const previous = this.previous;
    const cached = sample.cachedTokens ?? 0;
    this.totals.requestCount += 1;
    this.totals.promptTokens += Math.max(0, sample.promptTokens);
    this.totals.cachedTokens += Math.max(0, cached);
    if (cached > 0) this.sawCacheActivity = true;

    // 没有基线：普通的第一轮只建基线。压缩刚开了新会话时，这一轮是预期的冷启动。
    if (previous === undefined || sample.promptTokens <= 0) {
      const reason = previous === undefined ? this.coldStart : undefined;
      if (previous === undefined) this.coldStart = undefined;
      this.previous = sample;
      if (reason && sample.promptTokens > 0 && sample.cachedTokens !== undefined) {
        const missedTokens = Math.max(0, sample.promptTokens - cached);
        if (missedTokens > CACHE_NOISE_FLOOR) {
          return {
            missedTokens,
            modelChanged: false,
            likelyExpired: false,
            expected: true,
            reason,
          };
        }
      }
      return undefined;
    }
    if (sample.cachedTokens === undefined && !this.sawCacheActivity) {
      this.previous = sample;
      return undefined;
    }

    const missedTokens = Math.min(previous.promptTokens, sample.promptTokens) - cached;
    if (missedTokens <= CACHE_NOISE_FLOOR) {
      this.previous = sample;
      return undefined;
    }

    const idleMs = sample.at !== undefined && previous.at !== undefined
      ? Math.max(0, sample.at - previous.at)
      : undefined;
    const modelChanged = sample.modelKey !== undefined
      && previous.modelKey !== undefined
      && sample.modelKey !== previous.modelKey;

    // 换模型必然整段重算。记下来，但不要和「前缀被意外改写」加进同一笔 waste。
    if (!modelChanged) {
      this.totals.missedTokens += missedTokens;
      this.totals.missCount += 1;
    }
    this.previous = sample;
    return {
      missedTokens,
      ...(idleMs === undefined ? {} : { idleMs }),
      modelChanged,
      likelyExpired: idleMs !== undefined && idleMs >= CACHE_TTL_MS,
      expected: modelChanged,
      ...(modelChanged ? { reason: 'model' as const } : {}),
    };
  }

  /**
   * 下一次采样是压缩之后的新会话：整段重发是预期的，不进 waste。
   * 同时丢掉旧基线，避免拿压缩前的 prompt 长度来减。
   */
  expectColdStart(reason: 'compaction'): void {
    this.previous = undefined;
    this.coldStart = reason;
  }

  /**
   * 内容合法地重来一次（压缩重写了历史、开了新会话、换了模型）：丢掉基线。
   *
   * 不重置的话，压缩后的第一次请求会被算成一整段未命中——可那本来就是新内容，
   * 不是「本该命中却没命中」。
   */
  reset(): void {
    this.previous = undefined;
    this.coldStart = undefined;
  }

  get waste(): CacheWaste {
    return { ...this.totals };
  }
}

/** 命中率（0~1）。没有任何输入时返回 undefined，而不是编一个 0 出来。 */
export function cacheHitRate(waste: CacheWaste): number | undefined {
  if (waste.promptTokens <= 0) return undefined;
  return waste.cachedTokens / waste.promptTokens;
}

/**
 * 一句话描述这次未命中。
 *
 * 归因按可能性从高到低排列：换了模型（必然整段重算）→ 等太久（TTL 过期）→
 * 兜底只描述** mechanically 发生了什么**——端点没把缓存前缀读出来。至于原因，
 * 从 usage 里看不出来：可能是提供方丢了缓存（路由换节点、被驱逐），也可能前缀
 * 真的变了。编一个确定原因比说「两者之一」更糟。
 */
export function describeCacheMiss(miss: CacheMiss): string {
  const head = miss.expected
    ? `cache miss expected: ${miss.missedTokens} prompt tokens sent fresh`
    : `cache miss: ${miss.missedTokens} prompt tokens re-billed`;
  if (miss.reason === 'compaction') return `${head} — context was compacted into a new session`;
  if (miss.modelChanged) return `${head} — model changed, so the whole prompt is re-sent`;
  if (miss.likelyExpired && miss.idleMs !== undefined) {
    return `${head} — idle ${formatIdle(miss.idleMs)} (cache TTL ~${CACHE_TTL_MS / 60_000}m)`;
  }
  return `${head} — the provider served none of the cached prefix (cache loss or a front-of-prompt change)`;
}

function formatIdle(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.round(ms / 1000)}s`;
  return `${minutes}m`;
}
