// The library reads its config from AWS_EMF_* env vars at module-load time
// (see its EnvironmentConfigurationProvider) — set here as defaults, before
// importing it, rather than fighting the package's internal Environments
// enum type (not re-exported from its main entry point, and its deep import
// path doesn't resolve cleanly under this project's module resolution).
// CDK/docker-compose can still override either via real env vars.
process.env.AWS_EMF_ENVIRONMENT ??= "Local";
process.env.AWS_EMF_NAMESPACE ??= "escld/worker";
process.env.AWS_EMF_SERVICE_NAME ??= "worker";

// eslint-disable-next-line import/first
import { Unit, createMetricsLogger } from "aws-embedded-metrics";

import { logger } from "./logger.js";

/** Job outcome + duration — today there is zero duration visibility for
 * transcode jobs, the single biggest metrics blind spot this worker had. */
export async function recordJobResult(status: "success" | "failure", durationMs: number): Promise<void> {
  try {
    const metrics = createMetricsLogger();
    metrics.putDimensions({ status });
    metrics.putMetric("worker_jobs_total", 1, Unit.Count);
    metrics.putMetric("worker_job_duration_seconds", durationMs / 1000, Unit.Seconds);
    await metrics.flush();
  } catch (error) {
    // A metrics-emission failure must never break the job it's instrumenting.
    logger.warn("Failed to emit EMF metrics", { error });
  }
}
