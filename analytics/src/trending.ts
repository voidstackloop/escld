import type { Redis } from "ioredis";

import type { TrendingEntry } from "./types.js";

export type TrendingEntityType = "posts" | "hashtags";

const KEY_PREFIX = "trending:";
// Batch size per ZSCAN round trip during a decay pass.
const SCAN_BATCH_SIZE = 200;

/**
 * Trending is a single Redis sorted set per entity type, scored by weighted
 * engagement events and periodically decayed (see decay()) rather than
 * time-bucketed — simpler to operate for this app's scale, still gives a
 * "recent activity" ranking instead of an all-time cumulative one.
 */
export class TrendingStore {
  constructor(private readonly redis: Redis) {}

  async record(entityType: TrendingEntityType, id: string, weight: number): Promise<void> {
    if (weight <= 0) return;
    await this.redis.zincrby(this.key(entityType), weight, id);
  }

  async getTop(entityType: TrendingEntityType, limit: number): Promise<TrendingEntry[]> {
    const raw = await this.redis.zrevrange(this.key(entityType), 0, limit - 1, "WITHSCORES");
    const entries: TrendingEntry[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      const id = raw[i];
      const scoreStr = raw[i + 1];
      if (id !== undefined && scoreStr !== undefined) {
        entries.push({ id, score: Number.parseFloat(scoreStr) });
      }
    }
    return entries;
  }

  /** Multiplies every member's score by `factor`, pruning anything that
   * decays below `threshold`, so the sorted set doesn't grow forever with
   * long-dead entries sitting at a near-zero score.
   *
   * Walks the set with ZSCAN in bounded batches rather than one Lua script
   * over the whole set (the earlier design) — Redis executes a Lua script
   * atomically and single-threaded, so a script that loads and rewrites
   * every member in one call blocks *every other command on the whole Redis
   * instance* for its entire duration. That's invisible at dev scale, but
   * this Redis instance also backs the backend's distributed rate limiter
   * (see docs/INFRASTRUCTURE.md) — at real trending-set sizes, one blocking
   * decay pass every five minutes would stall every API request's rate-limit
   * check app-wide for however long the scan took. Batches let other
   * clients' commands interleave between round trips; the trade is losing
   * single-call atomicity, which is fine here — decay racing a concurrent
   * record() means one score is stale by one weighted increment for at most
   * one cycle, not a correctness issue for a trending heuristic. */
  async decay(entityType: TrendingEntityType, factor: number, threshold: number): Promise<number> {
    const key = this.key(entityType);
    let cursor = "0";
    let pruned = 0;

    do {
      const [nextCursor, elements] = await this.redis.zscan(key, cursor, "COUNT", SCAN_BATCH_SIZE);
      cursor = nextCursor;
      if (elements.length === 0) continue;

      const pipeline = this.redis.pipeline();
      for (let i = 0; i < elements.length; i += 2) {
        const member = elements[i];
        const scoreStr = elements[i + 1];
        if (member === undefined || scoreStr === undefined) continue;

        const score = Number.parseFloat(scoreStr) * factor;
        if (score < threshold) {
          pipeline.zrem(key, member);
          pruned += 1;
        } else {
          pipeline.zadd(key, score, member);
        }
      }
      await pipeline.exec();
    } while (cursor !== "0");

    return pruned;
  }

  private key(entityType: TrendingEntityType): string {
    return `${KEY_PREFIX}${entityType}`;
  }
}
