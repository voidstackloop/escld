// The library reads its config from AWS_EMF_* env vars at module-load time
// (see its EnvironmentConfigurationProvider) — set here as defaults, before
// importing it, rather than fighting the package's internal Environments
// enum type (not re-exported from its main entry point, and its deep import
// path doesn't resolve cleanly under this project's module resolution).
// CDK/docker-compose can still override either via real env vars.
process.env.AWS_EMF_ENVIRONMENT ??= "Local";
process.env.AWS_EMF_NAMESPACE ??= "escld/analytics";
process.env.AWS_EMF_SERVICE_NAME ??= "analytics";

// eslint-disable-next-line import/first
import { Unit, createMetricsLogger } from "aws-embedded-metrics";

import { logger } from "./logger.js";

export async function recordEventProcessed(eventType: string): Promise<void> {
  try {
    const metrics = createMetricsLogger();
    metrics.putDimensions({ eventType });
    metrics.putMetric("analytics_events_processed_total", 1, Unit.Count);
    await metrics.flush();
  } catch (error) {
    logger.warn("Failed to emit EMF metrics", { error });
  }
}

/** A gauge, not a counter — reflects the Redis client's current connection
 * state at the moment it's called, directly explaining "trending looks
 * stale" incidents beyond just the existing redis.on('error') log line. */
export async function recordRedisConnected(connected: boolean): Promise<void> {
  try {
    const metrics = createMetricsLogger();
    metrics.putMetric("analytics_redis_connected", connected ? 1 : 0, Unit.Count);
    await metrics.flush();
  } catch (error) {
    logger.warn("Failed to emit EMF metrics", { error });
  }
}
