import cron from "node-cron";
import { Redis } from "ioredis";
import { Kafka } from "kafkajs";

import { BucketedTrendingStore } from "./bucketed-trending.js";
import { loadConfig } from "./config.js";
import { handleEvent } from "./events.js";
import { logger } from "./logger.js";
import { recordRedisConnected } from "./metrics.js";
import { AnalyticsProcessor } from "./processor.js";
import { createServer } from "./server.js";
import { TrendingStore } from "./trending.js";
import { acquireDecayLock, releaseDecayLock } from "./trending-lock.js";
import { isAnalyticsEvent } from "./types.js";

const DECAY_LOCK_KEY = "lock:trending-decay";
// Deliberately NOT released the instant the pass finishes — confirmed by a
// real two-process repro against a live Redis: node-cron's own internal
// polling loop isn't millisecond-precise, so two independently-started
// replicas scheduled for the exact same wall-clock tick can still have their
// callbacks fire several hundred ms apart. Against an empty/near-empty
// trending set (decay() finishes in well under that gap), releasing
// immediately let the second, slightly-delayed replica re-acquire and run
// its OWN full decay pass within the same nominal tick — exactly the
// multiplication this lock exists to prevent, just narrowed from "every
// replica, every tick" to "occasionally two." Holding the lock a few extra
// seconds past completion costs nothing (the next real tick is 5+ minutes
// away by default) and fully closes that window.
const DECAY_LOCK_SETTLE_MS = 3000;

const config = loadConfig();

// ioredis requires a dedicated connection once it's in subscribe mode — it can
// no longer run other commands on that connection, hence two clients.
const redis = new Redis({ host: config.redisHost, port: config.redisPort });
const subscriber = new Redis({ host: config.redisHost, port: config.redisPort });

subscriber.on("error", (err) => logger.error("Redis subscriber error", { error: err }));
redis.on("error", (err) => {
  logger.error("Redis client error", { error: err });
  void recordRedisConnected(false);
});
redis.on("ready", () => void recordRedisConnected(true));
redis.on("close", () => void recordRedisConnected(false));

async function main(): Promise<void> {
  if (config.kafkaBootstrapServers) {
    // Stage 2 processor mode: Kafka consumer group + time-bucketed trending.
    // No Pub/Sub subscription, no per-replica decay cron — 1 vs 4 replicas
    // produce equal counts by construction.
    const trending = new BucketedTrendingStore(redis);
    const kafka = new Kafka({ clientId: "analytics", brokers: [config.kafkaBootstrapServers] });
    const processor = new AnalyticsProcessor(
      kafka,
      redis,
      { groupId: config.kafkaGroupId, topics: config.kafkaTopics }
    );
    await processor.start();
    logger.info("Analytics processor mode enabled", {
      groupId: config.kafkaGroupId,
      topics: config.kafkaTopics,
    });
    const app = createServer(trending, config.corsOrigin);
    app.listen(config.port, () => {
      logger.info("analytics service listening", { port: config.port, mode: "processor" });
    });
    return;
  }

  logger.warn("KAFKA_BOOTSTRAP_SERVERS unset — running legacy Redis Pub/Sub mode; trending decay is now guarded by a distributed lock so only one replica decays per tick");
  const trending = new TrendingStore(redis);
  await subscriber.subscribe(config.eventsChannel);
  logger.info("Subscribed to analytics events", { channel: config.eventsChannel });

  subscriber.on("message", (_channel, message) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch (err) {
      logger.warn("Discarding non-JSON analytics event", { error: err });
      return;
    }

    if (!isAnalyticsEvent(parsed)) {
      logger.warn("Discarding malformed analytics event", { message });
      return;
    }

    handleEvent(parsed, trending, config.weights).catch((err) => {
      logger.error("Failed to record analytics event", { error: err, event: parsed });
    });
  });

  cron.schedule(config.decayCronSchedule, () => {
    void (async () => {
      const ownerToken = await acquireDecayLock(redis, DECAY_LOCK_KEY, config.decayLockTtlMs);
      if (ownerToken === null) {
        logger.info("Skipping trending decay — another replica holds the lock");
        return;
      }
      try {
        const [postsPruned, hashtagsPruned] = await Promise.all([
          trending.decay("posts", config.decayFactor, config.decayPruneThreshold),
          trending.decay("hashtags", config.decayFactor, config.decayPruneThreshold),
        ]);
        logger.info("Trending decay pass complete", { postsPruned, hashtagsPruned });
      } catch (err) {
        logger.error("Trending decay pass failed", { error: err });
      } finally {
        await new Promise((resolve) => setTimeout(resolve, DECAY_LOCK_SETTLE_MS));
        await releaseDecayLock(redis, DECAY_LOCK_KEY, ownerToken);
      }
    })();
  });
  logger.info("Scheduled trending decay job", { schedule: config.decayCronSchedule, lockTtlMs: config.decayLockTtlMs });

  const app = createServer(trending, config.corsOrigin);
  app.listen(config.port, () => {
    logger.info("analytics service listening", { port: config.port });
  });
}

main().catch((err) => {
  logger.error("Fatal startup error", { error: err });
  process.exit(1);
});

// Every real failure path (a bad event, a Redis error) is already caught
// above — this is a backstop for anything outside that (a bug in a library,
// a stray rejection). Node crashes the whole process on an unhandled
// rejection by default; logging and continuing keeps the subscriber and the
// scheduled decay job alive instead of losing them to an unrelated error.
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", { error: reason });
});
process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", { error });
});
