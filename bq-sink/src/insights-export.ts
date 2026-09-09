import { BatchWriteItemCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

import type { Logger } from "./logger.js";
import type { Warehouse } from "./bigquery.js";

/** Mirrors post_daily's real columns (see canonicalizer.ts) — everything
 * this table now carries after the watchTimeMs/likeCount/commentCount
 * extension, not just the original qualified-reach/impressions/meaningful/
 * hide set. */
export interface PostDailyRow {
  postId: string;
  day: BigQueryDateLike;
  qualifiedReach: number;
  qualifiedImpressions: number;
  meaningfulCount: number;
  hideCount: number;
  medianDwellMs: number | null;
  watchTimeMs: number;
  likeCount: number;
  commentCount: number;
  asOf: BigQueryTimestampLike;
  provisional: boolean;
}

/** Mirrors creator_daily's real columns. */
export interface CreatorDailyRow {
  authorId: string;
  day: BigQueryDateLike;
  qualifiedReach: number;
  qualifiedImpressions: number;
  meaningfulCount: number;
  hideCount: number;
  distinctPosts: number;
  watchTimeMs: number;
  likeCount: number;
  commentCount: number;
  newFollowerCount: number;
  asOf: BigQueryTimestampLike;
  provisional: boolean;
}

/** The BigQuery Node client wraps DATE/TIMESTAMP columns in a small object
 * carrying the real value as a string on `.value` — plain strings are
 * accepted too, defensively, since this shape has changed across client
 * versions and isn't worth depending on precisely. */
type BigQueryDateLike = string | { value: string };
type BigQueryTimestampLike = string | { value: string };

function bigQueryValue(value: BigQueryDateLike | BigQueryTimestampLike): string {
  return typeof value === "string" ? value : value.value;
}

function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(value)) throw new Error(`Unsafe BigQuery identifier: ${value}`);
  return value;
}

export function postDailyExportSql(projectId: string, analyticsDataset: string): string {
  const project = identifier(projectId);
  const analytics = identifier(analyticsDataset);
  return `
SELECT postId, day, qualifiedReach, qualifiedImpressions, meaningfulCount, hideCount,
  medianDwellMs, IFNULL(watchTimeMs, 0) AS watchTimeMs, IFNULL(likeCount, 0) AS likeCount,
  IFNULL(commentCount, 0) AS commentCount, asOf, provisional
FROM \`${project}.${analytics}.post_daily\`
WHERE day >= DATE_SUB(CURRENT_DATE(), INTERVAL @lookbackDays DAY)
`;
}

export function creatorDailyExportSql(projectId: string, analyticsDataset: string): string {
  const project = identifier(projectId);
  const analytics = identifier(analyticsDataset);
  return `
SELECT authorId, day, qualifiedReach, qualifiedImpressions, meaningfulCount, hideCount, distinctPosts,
  IFNULL(watchTimeMs, 0) AS watchTimeMs, IFNULL(likeCount, 0) AS likeCount,
  IFNULL(commentCount, 0) AS commentCount, IFNULL(newFollowerCount, 0) AS newFollowerCount,
  asOf, provisional
FROM \`${project}.${analytics}.creator_daily\`
WHERE day >= DATE_SUB(CURRENT_DATE(), INTERVAL @lookbackDays DAY)
`;
}

/** DynamoDB item shape both post- and creator-level rows share — see
 * infra/lib/insights-stack.ts. pk distinguishes which entity a series
 * belongs to; sk is a plain lexicographically-sortable ISO date so a range
 * query (`sk BETWEEN DATE#from AND DATE#to`) needs no GSI. */
export function postDailyToItem(row: PostDailyRow): Record<string, unknown> {
  return {
    pk: `POST#${row.postId}`,
    sk: `DATE#${bigQueryValue(row.day)}`,
    qualifiedReach: row.qualifiedReach,
    qualifiedImpressions: row.qualifiedImpressions,
    meaningfulCount: row.meaningfulCount,
    hideCount: row.hideCount,
    medianDwellMs: row.medianDwellMs,
    watchTimeMs: row.watchTimeMs,
    likeCount: row.likeCount,
    commentCount: row.commentCount,
    asOf: bigQueryValue(row.asOf),
    provisional: row.provisional,
  };
}

export function creatorDailyToItem(row: CreatorDailyRow): Record<string, unknown> {
  return {
    pk: `CREATOR#${row.authorId}`,
    sk: `DATE#${bigQueryValue(row.day)}`,
    qualifiedReach: row.qualifiedReach,
    qualifiedImpressions: row.qualifiedImpressions,
    meaningfulCount: row.meaningfulCount,
    hideCount: row.hideCount,
    distinctPosts: row.distinctPosts,
    watchTimeMs: row.watchTimeMs,
    likeCount: row.likeCount,
    commentCount: row.commentCount,
    newFollowerCount: row.newFollowerCount,
    asOf: bigQueryValue(row.asOf),
    provisional: row.provisional,
  };
}

/** DynamoDB's own hard per-request limit — BatchWriteItem rejects anything
 * larger outright, it doesn't just slow down. */
const BATCH_WRITE_LIMIT = 25;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** Best-effort: this exporter re-runs hourly against a re-pulled window, so
 * a batch that fails today (throttling, a transient AWS error) gets another
 * real chance next run rather than needing its own retry/backoff machinery
 * here — matches this app's broader "durable batch job, not required to be
 * perfect on one pass" posture (e.g. the canonicalization loop above). */
export async function writeInsightsItems(
  dynamo: DynamoDBClient,
  tableName: string,
  items: Record<string, unknown>[],
  logger: Logger,
): Promise<{ written: number; failed: number }> {
  let written = 0;
  let failed = 0;
  for (const batch of chunk(items, BATCH_WRITE_LIMIT)) {
    try {
      const response = await dynamo.send(new BatchWriteItemCommand({
        RequestItems: {
          [tableName]: batch.map((item) => ({ PutRequest: { Item: toAttributeMap(item) } })),
        },
      }));
      const unprocessed = response.UnprocessedItems?.[tableName]?.length ?? 0;
      written += batch.length - unprocessed;
      failed += unprocessed;
      if (unprocessed > 0) {
        logger.warn("Some insights rows were unprocessed by DynamoDB, will retry next export run", { unprocessed });
      }
    } catch (error) {
      logger.error("Insights DynamoDB batch write failed, will retry next export run", { error, batchSize: batch.length });
      failed += batch.length;
    }
  }
  return { written, failed };
}

/** Plain-JS-value -> DynamoDB AttributeValue, scoped to exactly the value
 * shapes postDailyToItem/creatorDailyToItem ever produce (string, number,
 * boolean, or null) — not a general-purpose marshaller. */
function toAttributeMap(item: Record<string, unknown>): Record<string, import("@aws-sdk/client-dynamodb").AttributeValue> {
  const result: Record<string, import("@aws-sdk/client-dynamodb").AttributeValue> = {};
  for (const [key, value] of Object.entries(item)) {
    if (value === null || value === undefined) {
      result[key] = { NULL: true };
    } else if (typeof value === "number") {
      result[key] = { N: String(value) };
    } else if (typeof value === "boolean") {
      result[key] = { BOOL: value };
    } else {
      result[key] = { S: String(value) };
    }
  }
  return result;
}

export async function runInsightsExport(
  warehouse: Warehouse,
  dynamo: DynamoDBClient,
  tableName: string,
  analyticsDataset: string,
  lookbackDays: number,
  logger: Logger,
): Promise<{ written: number; failed: number }> {
  const [postRows, creatorRows] = await Promise.all([
    warehouse.queryPostDaily(analyticsDataset, lookbackDays),
    warehouse.queryCreatorDaily(analyticsDataset, lookbackDays),
  ]);
  const items = [...postRows.map(postDailyToItem), ...creatorRows.map(creatorDailyToItem)];
  if (items.length === 0) return { written: 0, failed: 0 };
  return writeInsightsItems(dynamo, tableName, items, logger);
}
