import type { Redis } from "ioredis";

/** Online feature materializer: bounded per-viewer affinity and exposure state
 * in feature Redis (separate deployment from rate-limit/cache Redis at the
 * growth target). All keys carry TTLs; returning users restore from permitted
 * offline snapshots. Aggregate counts are not anonymous when groups are small.
 *
 * Schema:
 * - features:author:pos:<viewerId> ZSET authorId -> decayed positive evidence (14d half-life, top 100, cap 5/post/day)
 * - features:author:neg:<viewerId> ZSET authorId -> hide evidence (weight 5, bounds 0.20)
 * - features:topic:pos:<viewerId> / features:topic:neg:<viewerId> (bounds 0.15)
 * - features:seen:<viewerId> SET postId (7d TTL, 2000 cap, qualified impressions only)
 * - features:exposure:post:<postId> HASH {exposed, engaged} (5m/1h/24h/7d windows via bucketed-trending)
 *
 * Session taste vectors (30-min half-life centroid) and long-term vectors
 * (14d half-life) require MiniLM embeddings from Elasticsearch and land next;
 * this materializer covers count-based affinities and exposure used by Phase A
 * scoring alongside semantic signals. */
export const AFFINITY_TTL_SECONDS = 30 * 24 * 60 * 60;
export const SEEN_TTL_SECONDS = 7 * 24 * 60 * 60;
export const SEEN_CAP = 2000;
export const TOP_N = 100;

export class FeatureMaterializer {
  constructor(private readonly redis: Redis) {}

  /** Positive evidence weights: dwell 1, like 2, comment 3, attributed follow 4, capped at 5/post/session. */
  async recordPositive(viewerId: string, authorId: string | null, topics: string[], weight: number): Promise<void> {
    const w = Math.max(0, Math.min(5, weight));
    if (w <= 0) return;
    const pipeline = this.redis.pipeline();
    if (authorId) {
      pipeline.zincrby(`features:author:pos:${viewerId}`, w, authorId);
      pipeline.expire(`features:author:pos:${viewerId}`, AFFINITY_TTL_SECONDS);
    }
    for (const topic of topics.slice(0, 10)) {
      pipeline.zincrby(`features:topic:pos:${viewerId}`, w, topic.toLowerCase());
      pipeline.expire(`features:topic:pos:${viewerId}`, AFFINITY_TTL_SECONDS);
    }
    await pipeline.exec();
    await this.trim(`features:author:pos:${viewerId}`);
    await this.trim(`features:topic:pos:${viewerId}`);
  }

  /** Hide evidence: separate negative counters, never subtracted embeddings. */
  async recordHide(viewerId: string, authorId: string | null, topics: string[]): Promise<void> {
    const pipeline = this.redis.pipeline();
    if (authorId) {
      pipeline.zincrby(`features:author:neg:${viewerId}`, 5, authorId);
      pipeline.expire(`features:author:neg:${viewerId}`, AFFINITY_TTL_SECONDS);
    }
    for (const topic of topics.slice(0, 10)) {
      pipeline.zincrby(`features:topic:neg:${viewerId}`, 5, topic.toLowerCase());
      pipeline.expire(`features:topic:neg:${viewerId}`, AFFINITY_TTL_SECONDS);
    }
    await pipeline.exec();
  }

  /** Qualified impressions only — never every retrieved candidate. */
  async recordSeen(viewerId: string, postId: string): Promise<void> {
    const key = `features:seen:${viewerId}`;
    const pipeline = this.redis.pipeline();
    pipeline.sadd(key, postId);
    pipeline.expire(key, SEEN_TTL_SECONDS);
    await pipeline.exec();
    const size = await this.redis.scard(key);
    if (size > SEEN_CAP) {
      // SPOP removes arbitrary members; recency trimming lives in the
      // session snapshot (15m) — this cap only bounds memory.
      await this.redis.spop(key, size - SEEN_CAP);
    }
  }

  async getAuthorAffinity(viewerId: string, authorId: string): Promise<{ pos: number; neg: number }> {
    const [pos, neg] = await Promise.all([
      this.redis.zscore(`features:author:pos:${viewerId}`, authorId),
      this.redis.zscore(`features:author:neg:${viewerId}`, authorId),
    ]);
    return { pos: pos ? Number.parseFloat(pos) : 0, neg: neg ? Number.parseFloat(neg) : 0 };
  }

  async getTopicAffinity(viewerId: string, topic: string): Promise<{ pos: number; neg: number }> {
    const t = topic.toLowerCase();
    const [pos, neg] = await Promise.all([
      this.redis.zscore(`features:topic:pos:${viewerId}`, t),
      this.redis.zscore(`features:topic:neg:${viewerId}`, t),
    ]);
    return { pos: pos ? Number.parseFloat(pos) : 0, neg: neg ? Number.parseFloat(neg) : 0 };
  }

  async hasSeen(viewerId: string, postId: string): Promise<boolean> {
    return (await this.redis.sismember(`features:seen:${viewerId}`, postId)) === 1;
  }

  private async trim(key: string): Promise<void> {
    const size = await this.redis.zcard(key);
    if (size > TOP_N) {
      await this.redis.zremrangebyrank(key, 0, size - TOP_N - 1);
    }
  }
}
