import { describe, expect, it, vi } from "vitest";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import {
  creatorDailyExportSql,
  creatorDailyToItem,
  postDailyExportSql,
  postDailyToItem,
  runInsightsExport,
  writeInsightsItems,
  type CreatorDailyRow,
  type PostDailyRow,
} from "./insights-export.js";
import type { Warehouse } from "./bigquery.js";
import type { Logger } from "./logger.js";

function silentLogger(): Logger {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger } as unknown as Logger;
  return logger;
}

describe("postDailyExportSql / creatorDailyExportSql", () => {
  it("selects from the already-materialized post_daily/creator_daily tables, not raw events", () => {
    expect(postDailyExportSql("project-1", "escld_analytics")).toContain(
      "FROM `project-1.escld_analytics.post_daily`",
    );
    expect(creatorDailyExportSql("project-1", "escld_analytics")).toContain(
      "FROM `project-1.escld_analytics.creator_daily`",
    );
  });

  it("filters to the trailing lookback window via a query parameter, not a fixed date", () => {
    expect(postDailyExportSql("project-1", "escld_analytics")).toContain(
      "day >= DATE_SUB(CURRENT_DATE(), INTERVAL @lookbackDays DAY)",
    );
  });

  it("rejects unsafe identifiers the same way canonicalizer.ts does", () => {
    expect(() => postDailyExportSql("project`; DROP TABLE x", "analytics")).toThrow("Unsafe");
  });
});

describe("postDailyToItem / creatorDailyToItem", () => {
  it("builds a POST# item keyed for a range query, carrying every post_daily metric", () => {
    const row: PostDailyRow = {
      postId: "post-1",
      day: { value: "2026-09-08" },
      qualifiedReach: 40,
      qualifiedImpressions: 55,
      meaningfulCount: 12,
      hideCount: 1,
      medianDwellMs: 3200,
      watchTimeMs: 900_000,
      likeCount: 8,
      commentCount: 3,
      asOf: { value: "2026-09-10T00:00:00.000Z" },
      provisional: false,
    };

    expect(postDailyToItem(row)).toEqual({
      pk: "POST#post-1",
      sk: "DATE#2026-09-08",
      qualifiedReach: 40,
      qualifiedImpressions: 55,
      meaningfulCount: 12,
      hideCount: 1,
      medianDwellMs: 3200,
      watchTimeMs: 900_000,
      likeCount: 8,
      commentCount: 3,
      asOf: "2026-09-10T00:00:00.000Z",
      provisional: false,
    });
  });

  it("accepts a plain string date/timestamp as well as the wrapped {value} shape", () => {
    const row: PostDailyRow = {
      postId: "post-2",
      day: "2026-09-01",
      qualifiedReach: 0,
      qualifiedImpressions: 0,
      meaningfulCount: 0,
      hideCount: 0,
      medianDwellMs: null,
      watchTimeMs: 0,
      likeCount: 0,
      commentCount: 0,
      asOf: "2026-09-01T00:00:00.000Z",
      provisional: true,
    };

    expect(postDailyToItem(row).sk).toBe("DATE#2026-09-01");
  });

  it("builds a CREATOR# item, distinct from POST#, carrying newFollowerCount", () => {
    const row: CreatorDailyRow = {
      authorId: "user-9",
      day: { value: "2026-09-08" },
      qualifiedReach: 200,
      qualifiedImpressions: 300,
      meaningfulCount: 90,
      hideCount: 2,
      distinctPosts: 4,
      watchTimeMs: 5_000_000,
      likeCount: 50,
      commentCount: 12,
      newFollowerCount: 7,
      asOf: { value: "2026-09-10T00:00:00.000Z" },
      provisional: false,
    };

    const item = creatorDailyToItem(row);
    expect(item.pk).toBe("CREATOR#user-9");
    expect(item.sk).toBe("DATE#2026-09-08");
    expect(item.newFollowerCount).toBe(7);
    expect(item.distinctPosts).toBe(4);
  });
});

describe("writeInsightsItems", () => {
  it("splits writes into DynamoDB's 25-item BatchWriteItem limit", async () => {
    const send = vi.fn().mockResolvedValue({ UnprocessedItems: {} });
    const dynamo = { send } as unknown as DynamoDBClient;
    const items = Array.from({ length: 30 }, (_, i) => ({ pk: `POST#${i}`, sk: "DATE#2026-09-08" }));

    const result = await writeInsightsItems(dynamo, "insights", items, silentLogger());

    expect(send).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ written: 30, failed: 0 });
  });

  it("counts unprocessed items as failed rather than silently dropping them", async () => {
    const send = vi.fn().mockResolvedValue({
      UnprocessedItems: { insights: [{ PutRequest: { Item: {} } }] },
    });
    const dynamo = { send } as unknown as DynamoDBClient;

    const result = await writeInsightsItems(
      dynamo,
      "insights",
      [{ pk: "POST#1", sk: "DATE#2026-09-08" }],
      silentLogger(),
    );

    expect(result).toEqual({ written: 0, failed: 1 });
  });

  it("counts a whole batch as failed on a thrown error, without throwing itself", async () => {
    const send = vi.fn().mockRejectedValue(new Error("throttled"));
    const dynamo = { send } as unknown as DynamoDBClient;

    const result = await writeInsightsItems(
      dynamo,
      "insights",
      [{ pk: "POST#1", sk: "DATE#2026-09-08" }],
      silentLogger(),
    );

    expect(result).toEqual({ written: 0, failed: 1 });
  });
});

describe("runInsightsExport", () => {
  it("fetches both post_daily and creator_daily and writes their union to DynamoDB", async () => {
    const postRow: PostDailyRow = {
      postId: "post-1",
      day: "2026-09-08",
      qualifiedReach: 1,
      qualifiedImpressions: 1,
      meaningfulCount: 0,
      hideCount: 0,
      medianDwellMs: null,
      watchTimeMs: 0,
      likeCount: 0,
      commentCount: 0,
      asOf: "2026-09-08T00:00:00.000Z",
      provisional: true,
    };
    const creatorRow: CreatorDailyRow = {
      authorId: "user-1",
      day: "2026-09-08",
      qualifiedReach: 1,
      qualifiedImpressions: 1,
      meaningfulCount: 0,
      hideCount: 0,
      distinctPosts: 1,
      watchTimeMs: 0,
      likeCount: 0,
      commentCount: 0,
      newFollowerCount: 0,
      asOf: "2026-09-08T00:00:00.000Z",
      provisional: true,
    };
    const warehouse = {
      queryPostDaily: vi.fn().mockResolvedValue([postRow]),
      queryCreatorDaily: vi.fn().mockResolvedValue([creatorRow]),
    } as unknown as Warehouse;
    const send = vi.fn().mockResolvedValue({ UnprocessedItems: {} });
    const dynamo = { send } as unknown as DynamoDBClient;

    const result = await runInsightsExport(warehouse, dynamo, "insights", "escld_analytics", 3, silentLogger());

    expect(warehouse.queryPostDaily).toHaveBeenCalledWith("escld_analytics", 3);
    expect(warehouse.queryCreatorDaily).toHaveBeenCalledWith("escld_analytics", 3);
    expect(result).toEqual({ written: 2, failed: 0 });
    const putItems = send.mock.calls[0]?.[0]?.input?.RequestItems?.insights ?? send.mock.calls[0]?.[0]?.RequestItems?.insights;
    expect(putItems).toHaveLength(2);
  });

  it("skips the DynamoDB call entirely when there are no rows to export", async () => {
    const warehouse = {
      queryPostDaily: vi.fn().mockResolvedValue([]),
      queryCreatorDaily: vi.fn().mockResolvedValue([]),
    } as unknown as Warehouse;
    const send = vi.fn();
    const dynamo = { send } as unknown as DynamoDBClient;

    const result = await runInsightsExport(warehouse, dynamo, "insights", "escld_analytics", 3, silentLogger());

    expect(send).not.toHaveBeenCalled();
    expect(result).toEqual({ written: 0, failed: 0 });
  });
});
