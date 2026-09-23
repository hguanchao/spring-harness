import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CACHE_NOISE_FLOOR,
  CACHE_TTL_MS,
  CacheMissTracker,
  cacheHitRate,
  type CacheSample,
} from '../../src/plugins/sph-llm/cache-stats.js';

function sample(promptTokens: number, cachedTokens?: number, extra: Partial<CacheSample> = {}): CacheSample {
  return { promptTokens, ...(cachedTokens === undefined ? {} : { cachedTokens }), ...extra };
}

describe('CacheMissTracker', () => {
  it('第一轮没有基线，不计未命中', () => {
    const tracker = new CacheMissTracker();
    assert.equal(tracker.observe(sample(20_000, 0)), undefined);
    assert.equal(tracker.waste.missCount, 0);
    assert.equal(tracker.waste.requestCount, 1, '进统计，但不进未命中');
  });

  it('完全命中时不报未命中', () => {
    const tracker = new CacheMissTracker();
    tracker.observe(sample(20_000, 18_000));
    assert.equal(tracker.observe(sample(21_000, 20_000)), undefined);
    assert.equal(tracker.waste.missedTokens, 0);
    assert.equal(tracker.waste.cachedTokens, 38_000);
  });

  it('低于噪声下限的差值不报，也不计入累计', () => {
    // 缓存按 128 / 1024 token 对齐，断点位置不可能完全吻合，这类差值是天然误差。
    const tracker = new CacheMissTracker();
    tracker.observe(sample(20_000, 19_000));
    assert.equal(tracker.observe(sample(20_500, 19_500)), undefined);
    assert.equal(tracker.waste.missCount, 0);
    assert.equal(tracker.waste.missedTokens, 0);
  });

  it('刚好越过噪声下限就报出来，并累加进总账', () => {
    const tracker = new CacheMissTracker();
    tracker.observe(sample(20_000, 19_000));
    // 上一轮的 20_000 全在提示里，本轮只从缓存读到 20_000 - (噪声下限 + 1)。
    const miss = tracker.observe(sample(20_000, 20_000 - CACHE_NOISE_FLOOR - 1));
    assert.equal(miss?.missedTokens, CACHE_NOISE_FLOOR + 1);
    assert.equal(tracker.waste.missCount, 1);
    assert.equal(tracker.waste.missedTokens, CACHE_NOISE_FLOOR + 1);
  });

  it('提示变短时按 min 计：少掉的那部分本轮不在提示里，不算未命中', () => {
    const tracker = new CacheMissTracker();
    tracker.observe(sample(60_000, 60_000));
    // 压缩后只剩 5_000，全都没命中；只有 5_000 该被记为「本该命中」。
    const miss = tracker.observe(sample(5_000, 0));
    assert.equal(miss?.missedTokens, 5_000);
  });

  it('端点从不上报缓存活动时不误报', () => {
    // 区分「只上报缓存读的端点整段未命中」与「这个端点根本不支持缓存」——
    // 后者报未命中会把用户引向不存在的优化。
    const tracker = new CacheMissTracker();
    tracker.observe(sample(20_000));
    assert.equal(tracker.observe(sample(21_000)), undefined);
    assert.equal(tracker.waste.missCount, 0);
  });

  it('见过缓存活动之后整段读为 0，算一次真未命中', () => {
    const tracker = new CacheMissTracker();
    tracker.observe(sample(20_000, 19_000));
    const miss = tracker.observe(sample(21_000, 0));
    assert.equal(miss?.missedTokens, 20_000);
    assert.equal(tracker.waste.missCount, 1);
  });

  it('闲置超过 CACHE_TTL_MS 时给出「大概率是过期」的归因', () => {
    const tracker = new CacheMissTracker();
    tracker.observe(sample(20_000, 19_000, { at: 0 }));
    const miss = tracker.observe(sample(21_000, 0, { at: CACHE_TTL_MS + 1 }));
    assert.equal(miss?.likelyExpired, true);
    assert.equal(miss?.idleMs, CACHE_TTL_MS + 1);

    const fresh = new CacheMissTracker();
    fresh.observe(sample(20_000, 19_000, { at: 0 }));
    assert.equal(fresh.observe(sample(21_000, 0, { at: CACHE_TTL_MS - 1 }))?.likelyExpired, false);
  });

  it('没有时间戳就不瞎猜闲置', () => {
    const tracker = new CacheMissTracker();
    tracker.observe(sample(20_000, 19_000));
    const miss = tracker.observe(sample(21_000, 0));
    assert.equal(miss?.idleMs, undefined);
    assert.equal(miss?.likelyExpired, false);
  });

  it('换模型单独标出来：那是预期行为，不进 waste', () => {
    const tracker = new CacheMissTracker();
    tracker.observe(sample(20_000, 19_000, { modelKey: 'a' }));
    const changed = tracker.observe(sample(21_000, 0, { modelKey: 'b' }));
    assert.equal(changed?.modelChanged, true);
    assert.equal(changed?.expected, true);
    assert.equal(changed?.reason, 'model');
    assert.equal(tracker.waste.missCount, 0, '换模型不该和前缀被改写算在同一笔里');
    const again = tracker.observe(sample(21_000, 0, { modelKey: 'b' }));
    assert.equal(again?.modelChanged, false);
    assert.equal(again?.expected, false);
    assert.equal(tracker.waste.missCount, 1);
  });

  it('压缩冷启动记成预期未命中，不进 waste', () => {
    const tracker = new CacheMissTracker();
    tracker.observe(sample(20_000, 19_000));
    tracker.expectColdStart('compaction');
    const miss = tracker.observe(sample(9_000, 0));
    assert.equal(miss?.expected, true);
    assert.equal(miss?.reason, 'compaction');
    assert.equal(miss?.missedTokens, 9_000);
    assert.equal(tracker.waste.missCount, 0);
    assert.equal(tracker.observe(sample(9_500, 9_000)), undefined, '冷启动之后重新有基线');
  });

  it('reset 之后的第一轮重新建立基线，不把压缩算成未命中', () => {
    const tracker = new CacheMissTracker();
    tracker.observe(sample(20_000, 19_000));
    tracker.reset();
    assert.equal(tracker.observe(sample(9_000, 0)), undefined, '压缩后是新内容，不是「本该命中」');
    assert.equal(tracker.waste.missCount, 0);
  });

  it('累计量跨多轮累加，requestCount 含未计未命中的那些', () => {
    const tracker = new CacheMissTracker();
    tracker.observe(sample(10_000, 9_000));
    tracker.observe(sample(11_000, 10_000));
    tracker.observe(sample(12_000, 0)); // 一次未命中
    const waste = tracker.waste;
    assert.equal(waste.requestCount, 3);
    assert.equal(waste.promptTokens, 33_000);
    assert.equal(waste.cachedTokens, 19_000);
    assert.equal(waste.missCount, 1);
    // 上一轮提示里有 11_000，本轮一个都没从缓存读到。
    assert.equal(waste.missedTokens, 11_000);
  });

  it('每次 observe 都推进基线，未命中不会被重复计一次', () => {
    const tracker = new CacheMissTracker();
    tracker.observe(sample(20_000, 19_000));
    tracker.observe(sample(21_000, 0));
    // 第二轮整段没命中，但它的 promptTokens 不该再被算第三次。
    tracker.observe(sample(22_000, 21_000));
    assert.equal(tracker.waste.missCount, 1);
  });

  it('waste 返回快照，外部改不动内部状态', () => {
    const tracker = new CacheMissTracker();
    tracker.observe(sample(10_000, 9_000));
    const snapshot = tracker.waste;
    snapshot.missCount = 99;
    assert.equal(tracker.waste.missCount, 0);
  });
});

describe('cacheHitRate', () => {
  it('按含缓存口径算命中率', () => {
    assert.equal(cacheHitRate({ requestCount: 2, promptTokens: 100, cachedTokens: 75, missedTokens: 0, missCount: 0 }), 0.75);
  });

  it('没有输入时不编一个 0 出来', () => {
    assert.equal(cacheHitRate({ requestCount: 0, promptTokens: 0, cachedTokens: 0, missedTokens: 0, missCount: 0 }), undefined);
  });
});

describe('常量', () => {
  it('CACHE_TTL_MS 用 Anthropic 的 5 分钟，与 OpenAI 自动缓存同数量级', () => {
    assert.equal(CACHE_TTL_MS, 5 * 60 * 1000);
  });
});
