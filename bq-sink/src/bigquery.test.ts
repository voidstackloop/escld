import { describe, expect, it, vi } from "vitest";
import type { BigQuery } from "@google-cloud/bigquery";
import type { AuthClient } from "google-auth-library";

import { Warehouse, tableForEventType } from "./bigquery.js";

describe("tableForEventType", () => {
  it("routes negative preference events to dedicated raw tables", () => {
    expect(tableForEventType("post.unliked")).toBe("raw_post_unliked");
    expect(tableForEventType("post.hidden")).toBe("raw_post_hidden");
    expect(tableForEventType("post.unhidden")).toBe("raw_post_unhidden");
  });

  it("routes comment lifecycle events to dedicated raw tables", () => {
    expect(tableForEventType("post.commented")).toBe("raw_post_commented");
    expect(tableForEventType("post.comment_deleted")).toBe("raw_post_comment_deleted");
  });

  it("routes qualified observation events to dedicated raw tables", () => {
    expect(tableForEventType("post.impression")).toBe("raw_post_impression");
    expect(tableForEventType("post.dwell")).toBe("raw_post_dwell");
    expect(tableForEventType("feed.served")).toBe("raw_feed_served");
    expect(tableForEventType("media.progress")).toBe("raw_media_progress");
  });
});

describe("Warehouse partial failures", () => {
  function warehouseWith(insert: ReturnType<typeof vi.fn>) {
    const table = vi.fn().mockReturnValue({ insert });
    const client = { dataset: vi.fn().mockReturnValue({ table }) } as unknown as BigQuery;
    return { warehouse: new Warehouse("project", "dataset", {} as AuthClient, client), table };
  }

  it("quarantines permanently rejected rows before reporting success", async () => {
    const insert = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("partial"), {
        name: "PartialFailureError",
        errors: [{
          row: { insertId: "evt-1", json: { eventId: "evt-1", correlationId: "corr-1" } },
          errors: [{ reason: "invalid", message: "unknown field" }],
        }],
      }))
      .mockResolvedValueOnce(undefined);
    const { warehouse, table } = warehouseWith(insert);

    const result = await warehouse.insertEvents("raw_post_created", [
      { insertId: "evt-1", row: { eventId: "evt-1" } },
    ]);

    expect(result).toEqual({ quarantined: 1 });
    expect(table).toHaveBeenNthCalledWith(2, "raw_ingestion_errors");
    expect(insert.mock.calls[1]?.[0]).toEqual([
      expect.objectContaining({
        insertId: "bq-reject-evt-1",
        json: expect.objectContaining({ reason: "BIGQUERY_ROW_REJECTED", errorMessage: "unknown field" }),
      }),
    ]);
  });

  it("rethrows transient partial failures for Kafka redelivery", async () => {
    const failure = Object.assign(new Error("partial"), {
      name: "PartialFailureError",
      errors: [{
        row: { insertId: "evt-1", json: { eventId: "evt-1" } },
        errors: [{ reason: "backendError", message: "try again" }],
      }],
    });
    const insert = vi.fn().mockRejectedValue(failure);
    const { warehouse } = warehouseWith(insert);

    await expect(warehouse.insertEvents("raw_post_created", [
      { insertId: "evt-1", row: { eventId: "evt-1" } },
    ])).rejects.toBe(failure);

    expect(insert).toHaveBeenCalledOnce();
  });

  it("retries unknown row error reasons rather than risking data loss", async () => {
    const failure = Object.assign(new Error("partial"), {
      name: "PartialFailureError",
      errors: [{
        row: { insertId: "evt-1", json: { eventId: "evt-1" } },
        errors: [{ reason: "stopped", message: "not attempted" }],
      }],
    });
    const insert = vi.fn().mockRejectedValue(failure);
    const { warehouse } = warehouseWith(insert);

    await expect(warehouse.insertEvents("raw_post_created", [
      { insertId: "evt-1", row: { eventId: "evt-1" } },
    ])).rejects.toBe(failure);
  });

  it("preserves source lineage in quarantine rows for replayable rejects", async () => {
    const insert = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("partial"), {
        name: "PartialFailureError",
        errors: [{
          row: {
            insertId: "evt-9",
            json: {
              eventId: "evt-9",
              eventType: "post.created",
              correlationId: "corr-9",
              sourceTopic: "post.created",
              sourcePartition: 2,
              sourceOffset: "123",
            },
          },
          errors: [{ reason: "invalid", message: "bad field" }],
        }],
      }))
      .mockResolvedValueOnce(undefined);
    const { warehouse } = warehouseWith(insert);

    const result = await warehouse.insertEvents("raw_post_created", [
      {
        insertId: "evt-9",
        row: {
          eventId: "evt-9",
          eventType: "post.created",
          sourceTopic: "post.created",
          sourcePartition: 2,
          sourceOffset: "123",
        },
      },
    ]);

    expect(result).toEqual({ quarantined: 1 });
    expect(insert.mock.calls[1]?.[0]).toEqual([
      expect.objectContaining({
        insertId: "bq-reject-evt-9",
        json: expect.objectContaining({
          eventId: "evt-9",
          topic: "post.created",
          partition: 2,
          offset: "123",
          sourceTopic: "post.created",
          sourcePartition: 2,
          sourceOffset: "123",
          reason: "BIGQUERY_ROW_REJECTED",
        }),
      }),
    ]);
  });
});
