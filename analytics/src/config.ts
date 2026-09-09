function int(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function float(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export interface Config {
  port: number;
  corsOrigin: string;
  redisHost: string;
  redisPort: number;
  eventsChannel: string;
  /** node-cron schedule for the legacy decay pass — used only when Kafka
   * processor mode is disabled. Kafka mode uses time-bucketed trending with
   * no global decay job. */
  decayCronSchedule: string;
  decayFactor: number;
  /** Scores below this get pruned during a decay pass so the sorted sets don't grow forever. */
  decayPruneThreshold: number;
  /** TTL for the distributed decay lock (legacy Pub/Sub mode only) — must
   * comfortably cover a real decay pass's duration, not just the interval
   * between ticks. Defaults to 80% of the default 5-minute cron interval. */
  decayLockTtlMs: number;
  weights: {
    postCreated: number;
    postLiked: number;
    postCommented: number;
  };
  /** Kafka processor mode (Stage 2): exactly one group member owns each
   * partition, so 1 vs 4 replicas produce equal counts. Empty bootstrap =
   * legacy Redis Pub/Sub mode. */
  kafkaBootstrapServers?: string | undefined;
  kafkaGroupId: string;
  kafkaTopics: string[];
}

/** Fails fast on startup if anything required is missing, rather than dying confusingly on the first request. */
export function loadConfig(): Config {
  return {
    port: int("PORT", 4100),
    corsOrigin: process.env.CORS_ALLOWED_ORIGINS ?? "http://localhost:5173",
    redisHost: process.env.REDIS_HOST ?? "localhost",
    redisPort: int("REDIS_PORT", 6379),
    eventsChannel: process.env.ANALYTICS_EVENTS_CHANNEL ?? "analytics-events",
    decayCronSchedule: process.env.TRENDING_DECAY_CRON ?? "*/5 * * * *",
    decayFactor: float("TRENDING_DECAY_FACTOR", 0.85),
    decayPruneThreshold: float("TRENDING_PRUNE_THRESHOLD", 0.05),
    decayLockTtlMs: int("TRENDING_DECAY_LOCK_TTL_MS", 240_000),
    weights: {
      postCreated: float("WEIGHT_POST_CREATED", 1),
      postLiked: float("WEIGHT_POST_LIKED", 3),
      postCommented: float("WEIGHT_POST_COMMENTED", 5),
    },
    kafkaBootstrapServers: process.env.KAFKA_BOOTSTRAP_SERVERS?.trim() || undefined,
    kafkaGroupId: process.env.KAFKA_GROUP_ID ?? "analytics-processor",
    kafkaTopics: (process.env.KAFKA_TOPICS ?? "domain.events.v2,behavior.events.v2")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
  };
}
