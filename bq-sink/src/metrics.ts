// The library reads its config from AWS_EMF_* env vars at module-load time
// (see its EnvironmentConfigurationProvider) — set here as defaults, before
// importing it, rather than fighting the package's internal Environments
// enum type (not re-exported from its main entry point, and its deep import
// path doesn't resolve cleanly under this project's module resolution).
// CDK/docker-compose can still override either via real env vars.
process.env.AWS_EMF_ENVIRONMENT ??= "Local";
process.env.AWS_EMF_NAMESPACE ??= "escld/bq-sink";
process.env.AWS_EMF_SERVICE_NAME ??= "bq-sink";

// eslint-disable-next-line import/first
import { Unit, createMetricsLogger } from "aws-embedded-metrics";

import { logger } from "./logger.js";

export async function recordEventResult(status: "success" | "failure", durationMs: number): Promise<void> {
  try {
    const metrics = createMetricsLogger();
    metrics.putDimensions({ status });
    metrics.putMetric("bq_sink_events_total", 1, Unit.Count);
    metrics.putMetric("bq_sink_event_duration_seconds", durationMs / 1000, Unit.Seconds);
    await metrics.flush();
  } catch (error) {
    logger.warn("Failed to emit EMF metrics", { error });
  }
}

export async function recordCanonicalizationResult(status: "success" | "failure", durationMs: number): Promise<void> {
  try {
    const metrics = createMetricsLogger();
    metrics.putDimensions({ status });
    metrics.putMetric("bq_canonicalization_runs_total", 1, Unit.Count);
    metrics.putMetric("bq_canonicalization_duration_seconds", durationMs / 1000, Unit.Seconds);
    await metrics.flush();
  } catch (error) {
    logger.warn("Failed to emit canonicalization metrics", { error });
  }
}
