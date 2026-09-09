import type { WorkerConfig } from "./types.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : undefined;
}

function int(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Fails fast on startup if anything required is missing, rather than dying
 * confusingly on the first job. */
export function loadConfig(): WorkerConfig {
  return {
    awsRegion: process.env.AWS_REGION ?? "eu-central-1",
    sqsEndpoint: optional("SQS_ENDPOINT"),
    dynamoEndpoint: optional("DYNAMODB_ENDPOINT"),
    queueUrl: required("SQS_POST_EVENTS_QUEUE_URL"),
    // Each unit of concurrency now runs its own independent SQS receive loop
    // (see index.ts's runLane) rather than sharing one batch receive, so this
    // is no longer bound by SQS's 10-message-per-call limit — only clamped
    // against misconfiguration.
    concurrency: Math.min(int("WORKER_CONCURRENCY", 2), 25),
    maxReceiveCount: int("SQS_MAX_RECEIVE_COUNT", 3),
    healthPort: int("HEALTH_PORT", 8080),
    elasticsearchUrl: required("ELASTICSEARCH_URL"),
    postsIndex: process.env.POSTS_SEARCH_INDEX ?? "posts_search",
    followsTableName: process.env.DYNAMODB_FOLLOWS_TABLE ?? "follows",
    feedTableName: process.env.DYNAMODB_FEED_TABLE ?? "feed",
  };
}
