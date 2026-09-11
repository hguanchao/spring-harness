/**
 * 上游模型目录的磁盘缓存（默认 `~/.sph/models.json`）。
 *
 * 动机：`/model` 原来每次都现拉 `/models`，用户在弹窗出现前要干等一个完整的 RTT（走代理更久），
 * 而模型目录几个月才变一次。改成启动时预热一次、结果落盘，之后启动直接命中，弹窗秒开。
 *
 * 两个刻意的设计：
 *
 * 1. **按 base URL 分桶**。同一个 `~/.sph` 下用户可能换过上游，A 端点的模型列表绝不能拿去给
 *    B 端点用（会选到一个不存在的模型，直到发请求才报错）。这里只存规范化后的 base URL，
 *    不存 apiKey —— 缓存文件是明文躺在主目录里的，不该出现凭据。
 * 2. **读取永远容错**。缓存是纯粹的加速手段，坏掉/过期/格式变了都必须退化成「当作没有缓存」，
 *    绝不能因为一个 JSON 解析失败就让 `/model` 报错。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { sphModelsPath } from '../home.js';

/** 超过这个年龄的缓存仍然会被立刻拿来显示，但会同时触发一次后台刷新。 */
export const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** 单个上游最多记多少个模型：防上游返回巨量条目把文件撑大。 */
const MAX_MODELS = 500;

/** 最多保留几个上游分桶，超出丢最旧的。用户不会真的配十几个端点。 */
const MAX_BUCKETS = 8;

interface CacheEntry {
  baseUrl: string;
  fetchedAt: number;
  models: string[];
  /**
   * 每个模型已知的容量参数（用户在 /model 向导里确认过的值）。
   * 上游的 `/models` 普遍不返回上下文窗口，只能靠用户输入沉淀；记下来之后，
   * 换回同一个模型就不必再手填一遍，`--model` 启动时也能直接取到正确的窗口。
   */
  meta?: Record<string, ModelMeta>;
}

/** 一个模型已知的容量参数。字段可选：只知道其一也值得记。 */
export interface ModelMeta {
  contextWindow?: number;
  maxTokens?: number;
}

interface CacheFile {
  version: 1;
  entries: CacheEntry[];
}

export interface CachedModels {
  models: string[];
  /** 写入时间戳（毫秒）。调用方用它判断要不要后台刷新。 */
  fetchedAt: number;
}

/**
 * 分桶键：去掉查询串/哈希与结尾斜杠，并统一小写。
 *
 * 同一个端点的 base URL 在配置里可能写成 `https://x/v1`、`https://x/v1/`，甚至换了查询参数，
 * 规范化之后才不至于一个端点占好几个桶。路径保持大小写（有些网关的路径是区分大小写的）。
 */
export function normalizeBaseUrl(baseUrl: string): string {
  if (typeof baseUrl !== 'string') return '';
  const trimmed = baseUrl.trim();
  if (trimmed === '') return '';
  try {
    const url = new URL(trimmed);
    url.search = '';
    url.hash = '';
    url.protocol = url.protocol.toLowerCase();
    url.host = url.host.toLowerCase();
    return url.toString().replace(/\/+$/, '');
  } catch {
    // 不是合法 URL（例如测试里的假地址）：只做结尾斜杠裁剪，仍然可当分桶键用。
    return trimmed.replace(/\/+$/, '');
  }
}

function parseMeta(value: unknown): Record<string, ModelMeta> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, ModelMeta> = {};
  for (const [model, raw] of Object.entries(value as Record<string, unknown>)) {
    if (model === '' || raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const meta: ModelMeta = {};
    if (typeof row.contextWindow === 'number' && Number.isFinite(row.contextWindow) && row.contextWindow > 0) {
      meta.contextWindow = Math.floor(row.contextWindow);
    }
    if (typeof row.maxTokens === 'number' && Number.isFinite(row.maxTokens) && row.maxTokens > 0) {
      meta.maxTokens = Math.floor(row.maxTokens);
    }
    if (meta.contextWindow !== undefined || meta.maxTokens !== undefined) out[model] = meta;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readCacheFile(filePath: string): CacheEntry[] {
  if (!existsSync(filePath)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    const entries = (parsed as CacheFile).entries;
    if (!Array.isArray(entries)) return [];
    const out: CacheEntry[] = [];
    for (const raw of entries) {
      if (raw === null || typeof raw !== 'object') continue;
      const entry = raw as Partial<CacheEntry>;
      if (typeof entry.baseUrl !== 'string' || entry.baseUrl === '') continue;
      if (typeof entry.fetchedAt !== 'number' || !Number.isFinite(entry.fetchedAt)) continue;
      if (!Array.isArray(entry.models)) continue;
      const models = entry.models.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
      const meta = parseMeta(entry.meta);
      // 只有 meta 没有模型列表的分桶是合法的（用户先配了模型，目录还没拉过）。
      if (models.length === 0 && meta === undefined) continue;
      const next: CacheEntry = { baseUrl: entry.baseUrl, fetchedAt: entry.fetchedAt, models };
      if (meta !== undefined) next.meta = meta;
      out.push(next);
    }
    return out;
  } catch {
    // 坏文件当没有缓存：它是加速手段，不该成为故障点。
    return [];
  }
}

function writeCacheFile(filePath: string, entries: CacheEntry[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const body: CacheFile = { version: 1, entries };
  writeFileSync(filePath, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

/** 读某个上游的缓存。没有/坏掉/键为空一律返回 undefined，调用方据此决定要不要等网络。 */
export function readModelCache(baseUrl: string, filePath: string = sphModelsPath()): CachedModels | undefined {
  const key = normalizeBaseUrl(baseUrl);
  if (key === '') return undefined;
  const entry = readCacheFile(filePath).find((item) => item.baseUrl === key);
  return entry === undefined ? undefined : { models: [...entry.models], fetchedAt: entry.fetchedAt };
}

/**
 * 写某个上游的缓存。
 *
 * 空列表不写：上游偶发返回空（限流、网关抽风）不该把一份好缓存放掉。保留原分桶的顺序，
 * 本端点存在就原地更新，不存在则插到最前面，超出 MAX_BUCKETS 时丢最旧的。
 * 已沉淀的 meta 必须原样带走——刷新目录不该顺手清掉用户填过的窗口大小。
 */
export function writeModelCache(
  baseUrl: string,
  models: readonly string[],
  filePath: string = sphModelsPath(),
): void {
  const key = normalizeBaseUrl(baseUrl);
  if (key === '') return;
  const unique = [...new Set(models.filter((item) => typeof item === 'string' && item.trim() !== ''))]
    .slice(0, MAX_MODELS);
  if (unique.length === 0) return;

  const existing = readCacheFile(filePath);
  const previous = existing.find((item) => item.baseUrl === key);
  const entry: CacheEntry = { baseUrl: key, fetchedAt: Date.now(), models: unique };
  if (previous?.meta !== undefined) entry.meta = previous.meta;
  const others = existing.filter((item) => item.baseUrl !== key);
  writeCacheFile(filePath, [entry, ...others].slice(0, MAX_BUCKETS));
}

/** 读某个模型沉淀的容量参数。没有缓存/没有该模型都返回 undefined。 */
export function readModelMeta(
  baseUrl: string,
  model: string,
  filePath: string = sphModelsPath(),
): ModelMeta | undefined {
  const key = normalizeBaseUrl(baseUrl);
  if (key === '' || model === '') return undefined;
  const entry = readCacheFile(filePath).find((item) => item.baseUrl === key);
  return entry?.meta?.[model];
}

/**
 * 记下某个模型的容量参数（用户向导确认后写回）。
 *
 * 与 writeModelCache 一样是读-改-写：两者都会保留对方的数据。
 * 分桶不存在时创建一个只有 meta 的分桶——它同样有用（下次 `--model` 就能取到窗口）。
 */
export function writeModelMeta(
  baseUrl: string,
  model: string,
  meta: ModelMeta,
  filePath: string = sphModelsPath(),
): void {
  const key = normalizeBaseUrl(baseUrl);
  if (key === '' || model === '') return;
  const contextWindow = typeof meta.contextWindow === 'number' && meta.contextWindow > 0
    ? Math.floor(meta.contextWindow)
    : undefined;
  const maxTokens = typeof meta.maxTokens === 'number' && meta.maxTokens > 0 ? Math.floor(meta.maxTokens) : undefined;
  if (contextWindow === undefined && maxTokens === undefined) return;

  const existing = readCacheFile(filePath);
  const previous = existing.find((item) => item.baseUrl === key);
  const merged: ModelMeta = { ...previous?.meta?.[model] };
  if (contextWindow !== undefined) merged.contextWindow = contextWindow;
  if (maxTokens !== undefined) merged.maxTokens = maxTokens;
  const entry: CacheEntry = {
    baseUrl: key,
    fetchedAt: previous?.fetchedAt ?? Date.now(),
    models: previous?.models ?? [],
    meta: { ...previous?.meta, [model]: merged },
  };
  const others = existing.filter((item) => item.baseUrl !== key);
  writeCacheFile(filePath, [entry, ...others].slice(0, MAX_BUCKETS));
}
