import type { Consumer, EachBatchPayload, Kafka } from "kafkajs";
import type { Redis } from "ioredis";

import { BucketedTrendingStore } from "./bucketed-trending.js";
import { isDomainEnvelope, trendingContribution } from "./envelope.js";
import { FeatureMaterializer } from "./features.js";
import { logger } from "./logger.js";
import { ReceiptStore } from "./receipts.js";

export interface ProcessorConfig {
  groupId: string;
  topics: string[];
}

/** Kafka consumer-group processor: exactly one replica owns each partition,
 * so 1 vs 4 replicas produce equal finalized counts. Each event is applied
 * once via (eventId, projectionVersion, entityKey) receipts; duplicates,
 * reorders, and replays converge. Event-time buckets make replay rebuilds
 * equal clean runs. */
export class AnalyticsProcessor {
  private consumer: Consumer | undefined;

  constructor(
    private readonly kafka: Kafka,
    private readonly redis: Redis,
    private readonly config: ProcessorConfig,
    private readonly trending = new BucketedTrendingStore(redis),
    private readonly receipts = new ReceiptStore(redis),
    private readonly features = new FeatureMaterializer(redis)
  ) {}

  async start(): Promise<void> {
    this.consumer = this.kafka.consumer({ groupId: this.config.groupId });
    await this.consumer.connect();
    await this.consumer.subscribe({ topics: this.config.topics, fromBeginning: true });
    await this.consumer.run({
      autoCommit: false,
      eachBatch: (payload) => this.handleBatch(payload),
    });
    logger.info("Analytics processor running", {
      groupId: this.config.groupId,
      topics: this.config.topics,
    });
  }

  async stop(): Promise<void> {
    await this.consumer?.disconnect().catch((err) => logger.warn("Processor disconnect failed", { error: err }));
  }

  /** Exported for tests: processes one Kafka batch without a broker. */
  async handleBatch(payload: EachBatchPayload): Promise<void> {
    for (const message of payload.batch.messages) {
      if (!payload.isRunning() || payload.isStale()) return;
      const raw = message.value?.toString() ?? "";
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        logger.warn("Quarantining non-JSON analytics record", {
          topic: payload.batch.topic,
          partition: payload.batch.partition,
          offset: message.offset,
        });
        payload.resolveOffset(message.offset);
        continue;
      }
      if (!isDomainEnvelope(parsed)) {
        logger.warn("Quarantining invalid envelope", {
          topic: payload.batch.topic,
          partition: payload.batch.partition,
          offset: message.offset,
        });
        payload.resolveOffset(message.offset);
        continue;
      }
      // Suppression ledger: deleted accounts/posts never re-materialize.
      if (parsed.eventType === "user.deletion_requested" || parsed.eventType === "user.deletion_completed") {
        await this.applyDeletion(parsed);
        payload.resolveOffset(message.offset);
        continue;
      }
      if (await this.isSuppressed(parsed.actorId ?? null, parsed.payload)) {
        payload.resolveOffset(message.offset);
        continue;
      }
      const contribution = trendingContribution(parsed.eventType);
      if (contribution.kind === null) {
        payload.resolveOffset(message.offset);
        continue;
      }
      const entityKey = this.entityKey(parsed);
      if (entityKey === null) {
        payload.resolveOffset(message.offset);
        continue;
      }
      const claimed = await this.receipts.tryClaim(parsed.eventId, entityKey);
      if (!claimed) {
        payload.resolveOffset(message.offset);
        continue;
      }
      const eventTimeMs = Date.parse(parsed.occurredAt);
      const payloadTags = (parsed.payload.tags as string[] | undefined) ?? [];
      if (parsed.eventType === "post.created" && payloadTags.length > 0) {
        for (const tag of payloadTags.slice(0, 10)) {
          if (typeof tag === "string" && tag.length > 0) {
            await this.trending.record("hashtags", tag.toLowerCase(), contribution.weight, eventTimeMs);
          }
        }
      }
      const postId = (parsed.payload.postId as string | undefined) ?? (parsed.entityId ?? undefined);
      if (typeof postId === "string") {
        await this.trending.record("posts", postId, contribution.weight, eventTimeMs);
      }
      await this.materializeFeatures(parsed);
      payload.resolveOffset(message.offset);
    }
    await payload.commitOffsetsIfNecessary();
    await payload.heartbeat();
  }

  /** Count-based affinities and exposure for Phase A scoring. Semantic taste
   * vectors (MiniLM centroids) land next; author enrichment for likes uses
   * payload authorId when present, else warehouse post_versions join. */
  private async materializeFeatures(parsed: {
    actorId?: string | null;
    eventType: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    const viewerId = parsed.actorId;
    if (!viewerId) return;
    const tags = Array.isArray(parsed.payload.tags)
      ? (parsed.payload.tags as unknown[]).filter((t): t is string => typeof t === "string")
      : [];
    const authorId =
      typeof parsed.payload.authorId === "string"
        ? parsed.payload.authorId
        : typeof parsed.payload.followeeId === "string" && parsed.eventType.startsWith("user.")
          ? parsed.payload.followeeId
          : null;
    switch (parsed.eventType) {
      case "post.impression": {
        const postId = parsed.payload.postId;
        if (typeof postId === "string") await this.features.recordSeen(viewerId, postId);
        break;
      }
      case "post.liked":
        await this.features.recordPositive(viewerId, authorId, tags, 2);
        break;
      case "post.commented":
        await this.features.recordPositive(viewerId, authorId, tags, 3);
        break;
      case "user.followed":
        await this.features.recordPositive(viewerId, authorId, [], 4);
        break;
      case "post.hidden":
        await this.features.recordHide(viewerId, authorId, tags);
        break;
      default:
        break;
    }
  }

  private entityKey(parsed: { eventId: string; eventType: string; payload: Record<string, unknown> }): string | null {
    const postId = parsed.payload.postId;
    if (typeof postId === "string") return `post:${postId}:${parsed.eventType}`;
    return null;
  }

  /** Durable suppression before derived-state removal: online suppression
   * takes effect on acceptance (target 15m), warehouse cleanup within 7d. */
  private async applyDeletion(parsed: {
    actorId?: string | null;
    payload: Record<string, unknown>;
  }): Promise<void> {
    const userId =
      typeof parsed.payload.userId === "string" ? parsed.payload.userId : (parsed.actorId ?? null);
    if (userId) {
      await this.redis.sadd("suppression:users", userId);
      // Delete derived online state best-effort; warehouse rows are removed
      // by the canonical 7d cleanup using the same ledger.
      const pipeline = this.redis.pipeline();
      pipeline.del(`features:author:pos:${userId}`);
      pipeline.del(`features:author:neg:${userId}`);
      pipeline.del(`features:topic:pos:${userId}`);
      pipeline.del(`features:topic:neg:${userId}`);
      pipeline.del(`features:seen:${userId}`);
      await pipeline.exec().catch((err) => logger.warn("Failed to clear deleted-user features", { error: err }));
    }
    const owned = parsed.payload.ownedPostIds;
    if (Array.isArray(owned)) {
      for (const postId of owned.slice(0, 5000)) {
        if (typeof postId === "string" && postId.length > 0) {
          await this.redis.sadd("suppression:posts", postId).catch((err) =>
            logger.warn("Failed to suppress post", { error: err, postId })
          );
        }
      }
    }
  }

  private async isSuppressed(actorId: string | null, payload: Record<string, unknown>): Promise<boolean> {
    // Redis suppression sets, populated by privacy events (see suppression.ts).
    // Missing keys = not suppressed; fail-open would resurrect deleted data,
    // so any Redis error pauses this partition (throw) rather than skipping.
    const checks: Promise<number>[] = [];
    if (actorId) checks.push(this.redis.sismember("suppression:users", actorId).catch((err) => { throw err; }));
    const postId = payload.postId;
    if (typeof postId === "string") {
      checks.push(this.redis.sismember("suppression:posts", postId).catch((err) => { throw err; }));
    }
    if (checks.length === 0) return false;
    const results = await Promise.all(checks);
    return results.some((v) => v === 1);
  }
}
