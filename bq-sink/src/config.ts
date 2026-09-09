export interface Config {
  healthPort: number;
  awsRegion: string;
  /** Exactly one of kafkaClusterArn / kafkaLocalBootstrapServers is set —
   * validated in loadConfig, not by the type system, since which one is
   * required depends on the other's absence. */
  kafkaClusterArn?: string | undefined;
  /** Local-testing-only escape hatch: a plain "host:port" pointing at a
   * PLAINTEXT Kafka broker (docker-compose's `kafka` service), bypassing
   * the MSK GetBootstrapBrokers call and IAM/OAUTHBEARER auth entirely.
   * Never set in a real environment. */
  kafkaLocalBootstrapServers?: string | undefined;
  /** Phase 0: just post.created. Each new event type gets a new entry here
   * and a matching table-name mapping in bigquery.ts. */
  kafkaTopics: string[];
  kafkaGroupId: string;
  /** Full resource name of the GCP Workload Identity Federation AWS
   * provider (see bq-sink/setup-gcp.sh's final printed value) — the
   * audience presented to GCP's STS when exchanging this ECS task's own
   * AWS identity for a short-lived GCP token. No service-account key is
   * ever downloaded or stored (see gcp-auth.ts). Absent means this is a
   * local Kafka-hop smoke test with no real GCP project available —
   * index.ts swaps in a logging-only WarehouseLike instead of a real
   * BigQuery client rather than failing startup or attempting a doomed
   * API call. */
  gcpWorkloadIdentityProvider?: string | undefined;
  /** GCP service account bq-sink impersonates via the WIF provider above. */
  gcpServiceAccountEmail?: string | undefined;
  bigQueryProjectId?: string | undefined;
  bigQueryDataset: string;
  bigQueryAnalyticsDataset: string;
  /** Maximum rows per BigQuery streaming insert. */
  bigQueryBatchSize: number;
  /** S3 recovery archive beyond Kafka retention (§§9, 11.2). Empty means disabled. */
  archiveBucketName?: string | undefined;
  archivePrefix: string;
  canonicalizationIntervalMs: number;
  canonicalizationLookbackDays: number;
  reconciliationIntervalMs: number;
  reconciliationLookbackDays: number;
  initialReconciliationLookbackDays: number;
  /** DynamoDB table Creator Studio / per-post insights history reads from —
   * see infra/lib/insights-stack.ts. Absent disables the export entirely
   * (same graceful-degradation shape as archiveBucketName): a local Kafka-hop
   * smoke test has no such table and shouldn't fail startup over it. */
  insightsTableName?: string | undefined;
  insightsExportIntervalMs: number;
  /** How many trailing days of post_daily/creator_daily to re-pull on every
   * export run — not an incremental cursor. Re-pulling is cheap (a handful
   * of rows per post/creator per day) and correctly picks up label-maturity
   * revisions the canonicalizer applies to already-materialized days. */
  insightsExportLookbackDays: number;
}

function int(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boundedInt(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = int(name, fallback);
  if (parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

/** Fails fast on startup if anything required is missing, rather than dying
 * confusingly on the first message. */
export function loadConfig(): Config {
  const kafkaClusterArn = process.env.KAFKA_CLUSTER_ARN?.trim() || undefined;
  const kafkaLocalBootstrapServers = process.env.KAFKA_LOCAL_BOOTSTRAP_SERVERS?.trim() || undefined;
  if (!kafkaClusterArn && !kafkaLocalBootstrapServers) {
    throw new Error("Missing required environment variable: KAFKA_CLUSTER_ARN (or KAFKA_LOCAL_BOOTSTRAP_SERVERS for local testing)");
  }

  return {
    healthPort: int("HEALTH_PORT", 4200),
    awsRegion: process.env.AWS_REGION ?? "eu-central-1",
    kafkaClusterArn,
    kafkaLocalBootstrapServers,
    kafkaTopics: (process.env.KAFKA_TOPICS ?? "post.created").split(",").map((t) => t.trim()),
    kafkaGroupId: process.env.KAFKA_GROUP_ID ?? "bq-sink",
    gcpWorkloadIdentityProvider: process.env.GCP_WORKLOAD_IDENTITY_PROVIDER?.trim() || undefined,
    gcpServiceAccountEmail: process.env.GCP_SERVICE_ACCOUNT_EMAIL?.trim() || undefined,
    bigQueryProjectId: process.env.BIGQUERY_PROJECT_ID?.trim() || undefined,
    bigQueryDataset: process.env.BIGQUERY_DATASET ?? "escld_events_raw",
    bigQueryAnalyticsDataset: process.env.BIGQUERY_ANALYTICS_DATASET ?? "escld_analytics",
    bigQueryBatchSize: boundedInt("BIGQUERY_BATCH_SIZE", 500, 1, 500),
    archiveBucketName: process.env.ARCHIVE_BUCKET_NAME?.trim() || undefined,
    archivePrefix: process.env.ARCHIVE_PREFIX?.trim() || "escld-events",
    canonicalizationIntervalMs: boundedInt("CANONICALIZATION_INTERVAL_MS", 300_000, 10_000, 86_400_000),
    canonicalizationLookbackDays: boundedInt("CANONICALIZATION_LOOKBACK_DAYS", 2, 1, 30),
    reconciliationIntervalMs: boundedInt("RECONCILIATION_INTERVAL_MS", 86_400_000, 60_000, 604_800_000),
    reconciliationLookbackDays: boundedInt("RECONCILIATION_LOOKBACK_DAYS", 30, 1, 365),
    initialReconciliationLookbackDays: boundedInt("INITIAL_RECONCILIATION_LOOKBACK_DAYS", 3650, 1, 36500),
    insightsTableName: process.env.DYNAMODB_INSIGHTS_TABLE?.trim() || undefined,
    insightsExportIntervalMs: boundedInt("INSIGHTS_EXPORT_INTERVAL_MS", 3_600_000, 60_000, 86_400_000),
    insightsExportLookbackDays: boundedInt("INSIGHTS_EXPORT_LOOKBACK_DAYS", 3, 1, 90),
  };
}
