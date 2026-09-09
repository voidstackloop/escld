import type { Redis } from "ioredis";

import type { TrendingEntry } from "./types.js";
import type { TrendingEntityType } from "./trending.js";

/** Time-bucketed trending: no global multiply-every-member decay pass.
 * Each 5-minute event-time bucket is its own sorted set; reads union recent
 * buckets with age weights. Any replica computing from the same buckets gets
 * the same result — 1 vs 4 replicas produce equal finalized counts.
 *
 * Keys:
 * - trending:b:posts:<bucket5m> / trending:b:hashtags:<bucket5m> (7d TTL)
 * - trending:seen:<entityType>:<id> -> last bucket (for pruning, optional)
 *
 * Event time (occurredAt) selects the bucket, not wall-clock arrival, so
 * reordered/late events land in the correct bucket and replays rebuild
 * identically. Buckets expire after 7 days; older history lives in BigQuery. */
export const BUCKET_MINUTES = 5;
export const BUCKET_TTL_SECONDS = 7 * 24 * 60 * 60;

export function bucketKey(entityType: TrendingEntityType, bucket: number): string {
  return `trending:b:${entityType}:${bucket}`;
}

export function toBucket(eventTimeMs: number): number {
  return Math.floor(eventTimeMs / (BUCKET_MINUTES * 60_000));
}

export class BucketedTrendingStore {
  constructor(private readonly redis: Redis) {}

  async record(
    entityType: TrendingEntityType,
    id: string,
    weight: number,
    eventTimeMs: number = Date.now()
  ): Promise<void> {
    if (weight <= 0 || !Number.isFinite(weight)) return;
    const bucket = toBucket(eventTimeMs);
    const key = bucketKey(entityType, bucket);
    const pipeline = this.redis.pipeline();
    pipeline.zincrby(key, weight, id);
    pipeline.expire(key, BUCKET_TTL_SECONDS);
    await pipeline.exec();
  }

  /** Weighted sum of recent buckets: last 15m full weight, prev 45m half.
   * Returns top entries by velocity-aware score. minExposure filters
   * entities with <20 total weight (proxy for 20 exposed viewers until the
   * warehouse-qualified exposure join lands). */
  async getTop(
    entityType: TrendingEntityType,
    limit: number,
    nowMs: number = Date.now()
  ): Promise<TrendingEntry[]> {
    const current = toBucket(nowMs);
    // Last 3 buckets = 15m, previous 9 buckets = 45m.
    const recentBuckets = [0, 1, 2].map((d) => current - d);
    const prevBuckets = [3, 4, 5, 6, 7, 8, 9, 10, 11].map((d) => current - d);
    const tempKey = `trending:tmp:${entityType}:${current}:${Date.now() % 100000}`;
    try {
      const args: (string | number)[] = [tempKey, recentBuckets.length + prevBuckets.length];
      for (const b of recentBuckets) {
        args.push(bucketKey(entityType, b), 1);
      }
      for (const b of prevBuckets) {
        args.push(bucketKey(entityType, b), 0.5);
      }
      args.push("AGGREGATE", "SUM");
      // ZUNIONSTORE with missing keys treats them as empty — safe for cold start.
      await (this.redis.zunionstore as (...a: unknown[]) => Promise<number>)(...args);
      await this.redis.expire(tempKey, 60);
      const raw = await this.redis.zrevrange(tempKey, 0, limit - 1, "WITHSCORES");
      const entries: TrendingEntry[] = [];
      for (let i = 0; i < raw.length; i += 2) {
        const id = raw[i];
        const scoreStr = raw[i + 1];
        if (id !== undefined && scoreStr !== undefined) {
          const score = Number.parseFloat(scoreStr);
          if (score >= 20) entries.push({ id, score });
        }
      }
      return entries;
    } finally {
      await this.redis.del(tempKey).catch(() => undefined);
    }
  }

  /** Velocity for a single id: smoothed 15m engagement vs prev 45m average.
   * sigmoid(log((e15+2)/(ePrev45/3+2))) — matches design §6.4 trend term. */
  async velocity(
    entityType: TrendingEntityType,
    id: string,
    nowMs: number = Date.now()
  ): Promise<number> {
    const current = toBucket(nowMs);
    const recentBuckets = [0, 1, 2].map((d) => current - d);
    const prevBuckets = [3, 4, 5, 6, 7, 8, 9, 10, 11].map((d) => current - d);
    const pipeline = this.redis.pipeline();
    for (const b of recentBuckets) pipeline.zscore(bucketKey(entityType, b), id);
    for (const b of prevBuckets) pipeline.zscore(bucketKey(entityType, b), id);
    const results = await pipeline.exec();
    let e15 = 0;
    let ePrev = 0;
    results?.forEach(([err, val], idx) => {
      if (err || val === null || val === undefined) return;
      const n = Number.parseFloat(val as string);
      if (!Number.isFinite(n)) return;
      if (idx < 3) e15 += n;
      else ePrev += n;
    });
    const ratio = (e15 + 2) / (ePrev / 3 + 2);
    return 1 / (1 + Math.exp(-Math.log(ratio)));
  }
}
