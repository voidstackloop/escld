import { BigQuery } from "@google-cloud/bigquery";
import type { AuthClient } from "google-auth-library";

import type { DeadLetterRow, InsertResult, InsertRow } from "./message-handler.js";
import { canonicalMergeSql } from "./canonicalizer.js";
import { creatorDailyExportSql, postDailyExportSql, type CreatorDailyRow, type PostDailyRow } from "./insights-export.js";

type PartialInsertFailure = {
  row?: { insertId?: string; json?: Record<string, unknown> };
  errors?: Array<{ reason?: string; message?: string }>;
};

const PERMANENT_REASONS = new Set(["invalid", "invalidQuery"]);

/** One raw landing table per event type, no transformation — see the plan's
 * §7 for why a wide/unioned table was rejected. Extend this map, not the
 * insert logic, when a new event type ships. */
const TABLE_BY_EVENT_TYPE: Record<string, string> = {
  "post.created": "raw_post_created",
  "post.liked": "raw_post_liked",
  "post.unliked": "raw_post_unliked",
  "post.commented": "raw_post_commented",
  "post.comment_deleted": "raw_post_comment_deleted",
  "post.hidden": "raw_post_hidden",
  "post.unhidden": "raw_post_unhidden",
  "user.followed": "raw_user_followed",
  "user.unfollowed": "raw_user_unfollowed",
  "live.started": "raw_live_started",
  "live.ended": "raw_live_ended",
  "post.impression": "raw_post_impression",
  "post.dwell": "raw_post_dwell",
  "feed.served": "raw_feed_served",
  "media.progress": "raw_media_progress",
};

/** Pure lookup, no BigQuery client needed — exported standalone so the
 * local-mode LoggingWarehouse (index.ts) can reuse the real mapping without
 * constructing a fake `Warehouse`/BigQuery client just to call this. */
export function tableForEventType(eventType: string): string | undefined {
  return TABLE_BY_EVENT_TYPE[eventType];
}

export class Warehouse {
  private readonly bigquery: BigQuery;
  private readonly projectId: string;
  private readonly dataset: string;

  constructor(projectId: string, dataset: string, authClient: AuthClient, client?: BigQuery) {
    this.bigquery = client ?? new BigQuery({ projectId, authClient });
    this.projectId = projectId;
    this.dataset = dataset;
  }

  tableForEventType(eventType: string): string | undefined {
    return tableForEventType(eventType);
  }

  /** `insertId` supplies BigQuery's best-effort streaming-insert dedup key.
   * Canonical warehouse transformations must still deduplicate by eventId;
   * this only reduces duplicates from nearby Kafka redeliveries. `raw: true`
   * tells the client to treat each row as the
   * {insertId, json} shape below rather than auto-wrapping a plain object
   * (which would also auto-generate a random insertId, defeating the
   * dedup). */
  async insertEvents(tableId: string, rows: InsertRow[]): Promise<InsertResult> {
    try {
      await this.insertRaw(tableId, rows);
      return { quarantined: 0 };
    } catch (error) {
      const failures = partialFailures(error);
      if (!failures || failures.some(isTransientFailure)) throw error;

      const quarantineRows = failures.map((failure, index) => {
        const original = failure.row;
        const message = failure.errors?.map((item) => item.message).filter(Boolean).join("; ") ?? "";
        const originalJson = (original?.json ?? {}) as Record<string, unknown>;
        return {
          insertId: `bq-reject-${original?.insertId ?? `${tableId}-${index}`}`,
          row: {
            quarantinedAt: new Date().toISOString(),
            eventId: (originalJson.eventId as string | undefined) ?? original?.insertId ?? null,
            eventType: (originalJson.eventType as string | undefined) ?? null,
            topic: (originalJson.sourceTopic as string | undefined) ?? null,
            partition: (originalJson.sourcePartition as number | undefined) ?? null,
            offset: (originalJson.sourceOffset as string | undefined) ?? null,
            sourceTopic: (originalJson.sourceTopic as string | undefined) ?? null,
            sourcePartition: (originalJson.sourcePartition as number | undefined) ?? null,
            sourceOffset: (originalJson.sourceOffset as string | undefined) ?? null,
            reason: "BIGQUERY_ROW_REJECTED",
            correlationId: original?.json?.correlationId ?? null,
            errorMessage: message.slice(0, 4_096),
            rawMessage: JSON.stringify(original?.json ?? {}).slice(0, 65_536),
          },
        };
      });
      await this.insertRaw("raw_ingestion_errors", quarantineRows);
      return { quarantined: quarantineRows.length };
    }
  }

  async insertDeadLetters(rows: DeadLetterRow[]): Promise<void> {
    await this.insertRaw("raw_ingestion_errors", rows);
  }

  async canonicalize(analyticsDataset: string, lookbackDays: number): Promise<void> {
    await this.bigquery.query({
      query: canonicalMergeSql(this.projectId, this.dataset, analyticsDataset),
      params: { lookbackDays, outcomeLookbackDays: lookbackDays + 2 },
    });
  }

  /** Trailing `lookbackDays` of post_daily/creator_daily — the materialized
   * tables canonicalize() above already maintains — for the DynamoDB
   * insights exporter (see insights-export.ts). Plain SELECTs, not part of
   * the canonicalization MERGE pipeline: this only ever reads. */
  async queryPostDaily(analyticsDataset: string, lookbackDays: number): Promise<PostDailyRow[]> {
    const [rows] = await this.bigquery.query({
      query: postDailyExportSql(this.projectId, analyticsDataset),
      params: { lookbackDays },
    });
    return rows as PostDailyRow[];
  }

  async queryCreatorDaily(analyticsDataset: string, lookbackDays: number): Promise<CreatorDailyRow[]> {
    const [rows] = await this.bigquery.query({
      query: creatorDailyExportSql(this.projectId, analyticsDataset),
      params: { lookbackDays },
    });
    return rows as CreatorDailyRow[];
  }

  private async insertRaw(tableId: string, rows: InsertRow[]): Promise<void> {
    await this.bigquery.dataset(this.dataset).table(tableId)
      .insert(rows.map(({ insertId, row }) => ({ insertId, json: row })), { raw: true });
  }
}

function partialFailures(error: unknown): PartialInsertFailure[] | undefined {
  if (typeof error !== "object" || error === null || (error as { name?: string }).name !== "PartialFailureError") {
    return undefined;
  }
  const failures = (error as { errors?: unknown }).errors;
  return Array.isArray(failures) && failures.length > 0 ? failures as PartialInsertFailure[] : undefined;
}

function isTransientFailure(failure: PartialInsertFailure): boolean {
  const reasons = failure.errors?.map(({ reason }) => reason) ?? [];
  return reasons.length === 0 || reasons.some((reason) => !reason || !PERMANENT_REASONS.has(reason));
}
