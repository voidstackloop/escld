import { Warehouse, tableForEventType } from "./bigquery.js";
import { loadConfig } from "./config.js";
import { buildExternalAccountClient } from "./gcp-auth.js";
import { startHealthServer, type WorkerStats } from "./health.js";
import { runInsightsExport } from "./insights-export.js";
import { createConsumer } from "./kafka.js";
import { logger } from "./logger.js";
import { handleBatch, type DeadLetterRow, type InsertResult, type InsertRow, type MessageHandlerDeps, type WarehouseLike } from "./message-handler.js";
import { recordCanonicalizationResult } from "./metrics.js";
import { NoopArchiveWriter, S3ArchiveWriter } from "./archive.js";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import type { Consumer } from "kafkajs";

/** Local-testing-only stand-in for a real BigQuery-backed Warehouse — used
 * when no GCP_WORKLOAD_IDENTITY_PROVIDER is configured (a Kafka-hop smoke
 * test with no real GCP project available). Logs what it would have
 * inserted instead of calling BigQuery, so the full envelope-parsing and
 * table-mapping logic in message-handler.ts still runs for real against a
 * message that genuinely crossed a real Kafka broker — only the last-mile
 * BigQuery write is stubbed. Never used when the WIF config is set. */
class LoggingWarehouse implements WarehouseLike {
  tableForEventType(eventType: string): string | undefined {
    return tableForEventType(eventType);
  }

  async insertEvents(tableId: string, rows: InsertRow[]): Promise<InsertResult> {
    logger.info("[local mode] would insert BigQuery batch", { tableId, count: rows.length, rows });
    return { quarantined: 0 };
  }

  async insertDeadLetters(rows: DeadLetterRow[]): Promise<void> {
    logger.warn("[local mode] would quarantine invalid Kafka records", { count: rows.length, rows });
  }
}

const config = loadConfig();

const stats: WorkerStats = {
  jobsSucceeded: 0,
  jobsFailed: 0,
  jobsQuarantined: 0,
  canonicalizationsSucceeded: 0,
  canonicalizationsFailed: 0,
  lastCanonicalizedAt: null,
  startedAt: new Date().toISOString(),
};

let shuttingDown = false;
let consumer: Consumer | undefined;
let canonicalizationTimer: NodeJS.Timeout | undefined;
let reconciliationTimer: NodeJS.Timeout | undefined;
let insightsExportTimer: NodeJS.Timeout | undefined;
let canonicalizationRunning = false;
let pendingCanonicalizationLookbackDays = 0;
let insightsExportRunning = false;

/** Pulls the trailing lookback window of post_daily/creator_daily (already
 * kept current by canonicalize() above) into DynamoDB — the materialized
 * store PostInsightsService/CreatorStudio actually read from. Independent
 * of the canonicalization loop: a DynamoDB hiccup here must never affect
 * Kafka consumption or the BigQuery-side canonicalization job, and vice
 * versa — matches this file's own existing pattern of isolated,
 * independently-erroring background loops (see canonicalize() itself). */
async function exportInsights(warehouse: Warehouse, dynamo: DynamoDBClient, tableName: string, lookbackDays: number): Promise<void> {
  if (insightsExportRunning) return;
  insightsExportRunning = true;
  const startedAt = Date.now();
  try {
    const result = await runInsightsExport(warehouse, dynamo, tableName, config.bigQueryAnalyticsDataset, lookbackDays, logger);
    logger.info("Insights export completed", { ...result, lookbackDays, durationMs: Date.now() - startedAt });
  } catch (error) {
    logger.error("Insights export failed, will retry next interval", { error, lookbackDays, durationMs: Date.now() - startedAt });
  } finally {
    insightsExportRunning = false;
  }
}

async function canonicalize(warehouse: Warehouse, requestedLookbackDays: number): Promise<void> {
  pendingCanonicalizationLookbackDays = Math.max(pendingCanonicalizationLookbackDays, requestedLookbackDays);
  if (canonicalizationRunning) return;
  canonicalizationRunning = true;
  try {
    while (pendingCanonicalizationLookbackDays > 0) {
      const lookbackDays = pendingCanonicalizationLookbackDays;
      pendingCanonicalizationLookbackDays = 0;
      const startedAt = Date.now();
      try {
        await warehouse.canonicalize(config.bigQueryAnalyticsDataset, lookbackDays);
        stats.canonicalizationsSucceeded += 1;
        stats.lastCanonicalizedAt = new Date().toISOString();
        logger.info("Canonical warehouse merge completed", { lookbackDays, durationMs: Date.now() - startedAt });
        void recordCanonicalizationResult("success", Date.now() - startedAt);
      } catch (error) {
        stats.canonicalizationsFailed += 1;
        logger.error("Canonical warehouse merge failed", { error, lookbackDays, durationMs: Date.now() - startedAt });
        void recordCanonicalizationResult("failure", Date.now() - startedAt);
      }
    }
  } finally {
    canonicalizationRunning = false;
  }
}

async function main(): Promise<void> {
  let warehouse: WarehouseLike;
  if (config.gcpWorkloadIdentityProvider && config.gcpServiceAccountEmail && config.bigQueryProjectId) {
    logger.info("Authenticating to GCP via Workload Identity Federation", {
      serviceAccountEmail: config.gcpServiceAccountEmail,
    });
    const authClient = buildExternalAccountClient(
      config.gcpWorkloadIdentityProvider,
      config.gcpServiceAccountEmail,
      config.awsRegion
    );
    warehouse = new Warehouse(config.bigQueryProjectId, config.bigQueryDataset, authClient);
  } else {
    logger.info("No GCP_WORKLOAD_IDENTITY_PROVIDER configured — running in local mode, logging events instead of landing them in BigQuery");
    warehouse = new LoggingWarehouse();
  }
  const messageHandlerDeps: MessageHandlerDeps = { warehouse, logger, stats };

  if (config.archiveBucketName) {
    logger.info("S3 recovery archive enabled", {
      bucket: config.archiveBucketName,
      prefix: config.archivePrefix,
    });
    messageHandlerDeps.archive = new S3ArchiveWriter(
      new S3Client({ region: config.awsRegion }),
      config.archiveBucketName,
      config.archivePrefix,
      logger
    );
  } else {
    messageHandlerDeps.archive = new NoopArchiveWriter();
  }

  logger.info("Connecting to Kafka", {
    clusterArn: config.kafkaClusterArn,
    localBootstrapServers: config.kafkaLocalBootstrapServers,
    topics: config.kafkaTopics,
  });
  consumer = await createConsumer(
    config.awsRegion,
    config.kafkaClusterArn,
    config.kafkaLocalBootstrapServers,
    config.kafkaGroupId,
    config.kafkaTopics
  );

  await consumer.run({
    eachBatchAutoResolve: false,
    eachBatch: (payload) => handleBatch(payload, messageHandlerDeps, config.bigQueryBatchSize),
  });

  if (warehouse instanceof Warehouse) {
    void canonicalize(warehouse, config.initialReconciliationLookbackDays);
    canonicalizationTimer = setInterval(
      () => void canonicalize(warehouse, config.canonicalizationLookbackDays),
      config.canonicalizationIntervalMs
    );
    reconciliationTimer = setInterval(
      () => void canonicalize(warehouse, config.reconciliationLookbackDays),
      config.reconciliationIntervalMs
    );

    if (config.insightsTableName) {
      const dynamo = new DynamoDBClient({ region: config.awsRegion });
      const tableName = config.insightsTableName;
      logger.info("Insights export enabled", { tableName, intervalMs: config.insightsExportIntervalMs });
      void exportInsights(warehouse, dynamo, tableName, config.insightsExportLookbackDays);
      insightsExportTimer = setInterval(
        () => void exportInsights(warehouse, dynamo, tableName, config.insightsExportLookbackDays),
        config.insightsExportIntervalMs
      );
    } else {
      logger.info("No DYNAMODB_INSIGHTS_TABLE configured — Creator Studio / post insights export disabled");
    }
  }

  logger.info("bq-sink running", { topics: config.kafkaTopics, dataset: config.bigQueryDataset });
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("Shutdown signal received", { signal });

  if (canonicalizationTimer) clearInterval(canonicalizationTimer);
  if (reconciliationTimer) clearInterval(reconciliationTimer);
  if (insightsExportTimer) clearInterval(insightsExportTimer);
  await consumer?.disconnect().catch((error: unknown) => logger.warn("Error disconnecting consumer", { error }));
  logger.info("Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// Same reasoning as every other Node service in this app — a backstop for
// anything outside handleMessage's own try/catch, since Node crashes the
// whole process on an unhandled rejection by default.
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", { error: reason });
});
process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", { error });
});

startHealthServer(config.healthPort, () => shuttingDown, stats);
main().catch((error: unknown) => {
  logger.error("Fatal startup error", { error });
  process.exit(1);
});
