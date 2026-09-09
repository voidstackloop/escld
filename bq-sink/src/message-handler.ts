import type { EachBatchPayload, KafkaMessage } from "kafkajs";

import type { WorkerStats } from "./health.js";
import type { Logger } from "./logger.js";
import { recordEventResult } from "./metrics.js";

export interface EventEnvelope {
  eventId: string;
  eventType: string;
  eventVersion: string;
  occurredAt: string;
  ingestedAt?: string;
  producer?: string;
  actorId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  entityVersion?: number | null;
  correlationId?: string | null;
  sessionId?: string | null;
  requestId?: string | null;
  experimentId?: string | null;
  experimentVariant?: string | null;
  experiment?: { id?: string; variant?: string } | null;
  payload: Record<string, unknown>;
}

export interface InsertRow {
  insertId: string;
  row: Record<string, unknown>;
}

export interface DeadLetterRow extends InsertRow {}
export interface InsertResult { quarantined: number }

export function isEventEnvelope(value: unknown): value is EventEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const commonValid =
    typeof v.eventId === "string" &&
    typeof v.eventType === "string" &&
    (v.eventVersion === "1" || v.eventVersion === "2") &&
    typeof v.occurredAt === "string" &&
    isValidTimestamp(v.occurredAt) &&
    typeof v.payload === "object" &&
    v.payload !== null;
  if (!commonValid) return false;
  if (v.eventVersion === "1") return true;
  return (
    typeof v.ingestedAt === "string" &&
    isValidTimestamp(v.ingestedAt) &&
    typeof v.producer === "string" &&
    optionalString(v.actorId) &&
    optionalString(v.entityType) &&
    optionalString(v.entityId) &&
    (v.entityVersion === undefined || v.entityVersion === null || Number.isSafeInteger(v.entityVersion)) &&
    optionalString(v.correlationId) &&
    optionalString(v.sessionId) &&
    optionalString(v.requestId) &&
    optionalString(v.experimentId) &&
    optionalString(v.experimentVariant) &&
    (v.experiment === undefined || v.experiment === null || isExperimentContext(v.experiment))
  );
}

function isExperimentContext(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return optionalString(v.id) && optionalString(v.variant);
}

function isValidTimestamp(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

function optionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

export interface WarehouseLike {
  tableForEventType(eventType: string): string | undefined;
  insertEvents(tableId: string, rows: InsertRow[]): Promise<InsertResult>;
  insertDeadLetters(rows: DeadLetterRow[]): Promise<void>;
}

export interface MessageHandlerDeps {
  warehouse: WarehouseLike;
  logger: Logger;
  stats: WorkerStats;
  archive?: {
    writeBatch(records: { topic: string; partition: number; offset: string; envelopeJson: string }[]): Promise<void>;
  };
}

type ParsedMessage =
  | {
      kind: "event";
      offset: string;
      table: string;
      eventType: string;
      row: InsertRow;
      envelopeJson: string;
    }
  | { kind: "dead-letter"; offset: string; reason: string; row: DeadLetterRow };

function parseMessage(topic: string, partition: number, message: KafkaMessage, warehouse: WarehouseLike): ParsedMessage {
  const rawMessage = message.value?.toString() ?? "";
  const correlationId = message.headers?.correlationId?.toString() ?? null;
  let raw: unknown;
  try {
    raw = JSON.parse(rawMessage);
  } catch {
    return deadLetter(topic, partition, message.offset, correlationId, "MALFORMED_JSON", rawMessage);
  }
  if (!isEventEnvelope(raw)) {
    return deadLetter(topic, partition, message.offset, correlationId, "INVALID_EVENT_ENVELOPE", rawMessage);
  }
  const table = warehouse.tableForEventType(raw.eventType);
  if (!table) {
    return deadLetter(topic, partition, message.offset, correlationId, "UNMAPPED_EVENT_TYPE", rawMessage);
  }
  return {
    kind: "event",
    offset: message.offset,
    table,
    eventType: raw.eventType,
    envelopeJson: rawMessage,
    row: {
      insertId: raw.eventId,
      row: {
        ...raw.payload,
        eventId: raw.eventId,
        eventVersion: raw.eventVersion,
        occurredAt: raw.occurredAt,
        ingestedAt: raw.ingestedAt ?? null,
        producer: raw.producer ?? null,
        actorId: raw.actorId ?? null,
        entityType: raw.entityType ?? null,
        entityId: raw.entityId ?? null,
        entityVersion: raw.entityVersion ?? null,
        correlationId: raw.correlationId ?? correlationId,
        sessionId: raw.sessionId ?? (raw.payload.sessionId as string | undefined) ?? null,
        requestId: raw.requestId ?? (raw.payload.requestId as string | undefined) ?? null,
        experimentId:
          raw.experimentId ?? raw.experiment?.id ?? (raw.payload.experimentId as string | undefined) ?? null,
        experimentVariant:
          raw.experimentVariant ??
          raw.experiment?.variant ??
          (raw.payload.experimentVariant as string | undefined) ??
          null,
        eventType: raw.eventType,
        eventPayload: raw.payload,
        sourceTopic: topic,
        sourcePartition: partition,
        sourceOffset: message.offset,
      },
    },
  };
}

function deadLetter(topic: string, partition: number, offset: string, correlationId: string | null,
  reason: string, rawMessage: string): ParsedMessage {
  return {
    kind: "dead-letter",
    offset,
    reason,
    row: {
      insertId: `quarantine-${topic}-${partition}-${offset}`,
      row: {
        quarantinedAt: new Date().toISOString(),
        topic,
        partition,
        offset,
        reason,
        correlationId,
        rawMessage: rawMessage.slice(0, 65_536),
      },
    },
  };
}

/** Resolves offsets only after the corresponding landing or quarantine write succeeds.
 * Chunks by row count (batchSize, max 500) and by estimated payload bytes
 * (MAX_BATCH_BYTES, 0.9 MiB) so a burst of large observation payloads cannot
 * exceed BigQuery's 10 MiB streaming-insert limit and force a whole-chunk
 * transient retry storm. */
export const MAX_BATCH_BYTES = 900 * 1024;

function estimateRowBytes(item: ParsedMessage): number {
  try {
    return JSON.stringify(item.kind === "event" ? item.row.row : item.row.row).length;
  } catch {
    return 4096;
  }
}

export async function handleBatch(payload: EachBatchPayload, deps: MessageHandlerDeps, batchSize: number): Promise<void> {
  const startedAt = Date.now();
  const parsed = payload.batch.messages.map((message) =>
    parseMessage(payload.batch.topic, payload.batch.partition, message, deps.warehouse)
  );

  for (let index = 0; index < parsed.length;) {
    if (!payload.isRunning() || payload.isStale()) return;
    const first = parsed[index]!;
    const chunk: ParsedMessage[] = [first];
    let chunkBytes = estimateRowBytes(first);
    index += 1;
    while (index < parsed.length && chunk.length < batchSize) {
      const next = parsed[index]!;
      const sameDestination = first.kind === next.kind &&
        (first.kind === "dead-letter" || (next.kind === "event" && first.table === next.table));
      if (!sameDestination) break;
      const nextBytes = estimateRowBytes(next);
      if (chunkBytes + nextBytes > MAX_BATCH_BYTES && chunk.length > 0) break;
      chunk.push(next);
      chunkBytes += nextBytes;
      index += 1;
    }

    try {
      if (first.kind === "event") {
        const result = await deps.warehouse.insertEvents(first.table, chunk.map((item) => item.row));
        deps.stats.jobsSucceeded += chunk.length - result.quarantined;
        deps.stats.jobsQuarantined += result.quarantined;
        deps.logger.info("Landed BigQuery event batch", {
          eventType: first.eventType,
          table: first.table,
          count: chunk.length,
          quarantined: result.quarantined,
          durationMs: Date.now() - startedAt,
        });
        for (const _item of chunk) void recordEventResult("success", Date.now() - startedAt);
        // Best-effort recovery archive beyond Kafka retention. Archive
        // failures are logged and metered but never block BigQuery offsets:
        // the dedicated s3-archive consumer group is the follow-up for
        // exactly-once archive semantics.
        if (deps.archive) {
          const records = chunk
            .filter((item) => item.kind === "event")
            .map((item) => ({
              topic: payload.batch.topic,
              partition: payload.batch.partition,
              offset: item.offset,
              envelopeJson: (item as { envelopeJson: string }).envelopeJson,
            }));
          try {
            await deps.archive.writeBatch(records);
          } catch (error) {
            deps.logger.warn("S3 archive write failed; BigQuery offsets still commit", {
              error,
              count: records.length,
            });
          }
        }
      } else {
        await deps.warehouse.insertDeadLetters(chunk.map((item) => item.row));
        deps.stats.jobsQuarantined += chunk.length;
        deps.logger.warn("Quarantined invalid Kafka records", {
          reason: first.reason,
          count: chunk.length,
          topic: payload.batch.topic,
          partition: payload.batch.partition,
        });
      }
    } catch (error) {
      deps.stats.jobsFailed += chunk.length;
      deps.logger.error("Failed to write BigQuery batch", {
        error,
        count: chunk.length,
        destination: first.kind === "event" ? first.table : "raw_ingestion_errors",
      });
      for (const _item of chunk) void recordEventResult("failure", Date.now() - startedAt);
      throw error;
    }

    for (const item of chunk) payload.resolveOffset(item.offset);
    await payload.commitOffsetsIfNecessary();
    await payload.heartbeat();
  }
}
