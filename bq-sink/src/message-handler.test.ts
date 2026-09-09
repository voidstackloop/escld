import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EachBatchPayload, KafkaMessage } from "kafkajs";

vi.mock("./metrics.js", () => ({ recordEventResult: vi.fn().mockResolvedValue(undefined) }));

import { handleBatch, type MessageHandlerDeps, type WarehouseLike } from "./message-handler.js";
import type { WorkerStats } from "./health.js";
import type { Logger } from "./logger.js";

function makeLogger(): Logger {
  const noop: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => noop };
  return noop;
}

function makeDeps(overrides: Partial<MessageHandlerDeps> = {}): MessageHandlerDeps {
  const warehouse: WarehouseLike = {
    tableForEventType: vi.fn().mockReturnValue("raw_post_created"),
    insertEvents: vi.fn().mockResolvedValue({ quarantined: 0 }),
    insertDeadLetters: vi.fn().mockResolvedValue(undefined),
  };
  const stats: WorkerStats = {
    jobsSucceeded: 0,
    jobsFailed: 0,
    jobsQuarantined: 0,
    canonicalizationsSucceeded: 0,
    canonicalizationsFailed: 0,
    lastCanonicalizedAt: null,
    startedAt: new Date().toISOString(),
  };
  return { warehouse, logger: makeLogger(), stats, ...overrides };
}

function envelope(id: string, overrides: Record<string, unknown> = {}) {
  return {
    eventId: id,
    eventType: "post.created",
    eventVersion: "1",
    occurredAt: "2026-01-01T00:00:00.000Z",
    payload: { postId: `post-${id}`, authorId: "author-1" },
    ...overrides,
  };
}

function makeBatch(values: unknown[]): EachBatchPayload {
  const messages = values.map((value, index) => ({
    key: null,
    value: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)),
    timestamp: "0",
    attributes: 0,
    offset: String(index),
    headers: {},
  })) as KafkaMessage[];
  return {
    batch: { topic: "post.created", partition: 0, messages },
    resolveOffset: vi.fn(),
    heartbeat: vi.fn().mockResolvedValue(undefined),
    commitOffsetsIfNecessary: vi.fn().mockResolvedValue(undefined),
    uncommittedOffsets: vi.fn(),
    isRunning: () => true,
    isStale: () => false,
    pause: vi.fn(),
  } as unknown as EachBatchPayload;
}

describe("handleBatch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lands multiple records in one BigQuery call and resolves their offsets", async () => {
    const deps = makeDeps();
    const payload = makeBatch([envelope("evt-1"), envelope("evt-2")]);

    await handleBatch(payload, deps, 500);

    expect(deps.warehouse.insertEvents).toHaveBeenCalledOnce();
    expect(deps.warehouse.insertEvents).toHaveBeenCalledWith("raw_post_created", [
      expect.objectContaining({ insertId: "evt-1", row: expect.objectContaining({ eventId: "evt-1" }) }),
      expect.objectContaining({ insertId: "evt-2", row: expect.objectContaining({ eventId: "evt-2" }) }),
    ]);
    expect(payload.resolveOffset).toHaveBeenCalledTimes(2);
    expect(deps.stats.jobsSucceeded).toBe(2);
    expect(deps.warehouse.insertEvents).toHaveBeenCalledWith("raw_post_created", expect.arrayContaining([
      expect.objectContaining({ row: expect.objectContaining({
        eventType: "post.created", sourceTopic: "post.created", sourcePartition: 0, sourceOffset: "0",
      }) }),
    ]));
  });

  it("does not allow payload fields to replace authoritative metadata", async () => {
    const deps = makeDeps();
    const payload = makeBatch([envelope("evt-1", { payload: { eventId: "forged", eventVersion: "forged" } })]);

    await handleBatch(payload, deps, 500);

    expect(deps.warehouse.insertEvents).toHaveBeenCalledWith("raw_post_created", [
      expect.objectContaining({ row: expect.objectContaining({ eventId: "evt-1", eventVersion: "1" }) }),
    ]);
  });

  it("preserves ordered feed lineage both as a typed field and in the canonical payload", async () => {
    const deps = makeDeps();
    (deps.warehouse.tableForEventType as ReturnType<typeof vi.fn>).mockReturnValue("raw_feed_served");
    const orderedItems = [{ postId: "post-1", position: 1, source: "following_inbox", reasonCode: "following" }];
    const payload = makeBatch([envelope("evt-1", {
      eventType: "feed.served",
      payload: { requestId: "request-1", itemCount: 1, orderedItems },
    })]);

    await handleBatch(payload, deps, 500);

    expect(deps.warehouse.insertEvents).toHaveBeenCalledWith("raw_feed_served", [
      expect.objectContaining({ row: expect.objectContaining({
        requestId: "request-1",
        orderedItems,
        eventPayload: expect.objectContaining({ orderedItems }),
      }) }),
    ]);
  });

  it("quarantines malformed JSON and continues with the next valid record", async () => {
    const deps = makeDeps();
    const payload = makeBatch(["not-json", envelope("evt-2")]);

    await handleBatch(payload, deps, 500);

    expect(deps.warehouse.insertDeadLetters).toHaveBeenCalledWith([
      expect.objectContaining({ row: expect.objectContaining({ reason: "MALFORMED_JSON", offset: "0" }) }),
    ]);
    expect(deps.warehouse.insertEvents).toHaveBeenCalledOnce();
    expect(payload.resolveOffset).toHaveBeenNthCalledWith(1, "0");
    expect(payload.resolveOffset).toHaveBeenNthCalledWith(2, "1");
    expect(deps.stats.jobsQuarantined).toBe(1);
  });

  it("quarantines unmapped event types instead of dropping them", async () => {
    const deps = makeDeps();
    (deps.warehouse.tableForEventType as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const payload = makeBatch([envelope("evt-1", { eventType: "post.unknown" })]);

    await handleBatch(payload, deps, 500);

    expect(deps.warehouse.insertDeadLetters).toHaveBeenCalledWith([
      expect.objectContaining({ row: expect.objectContaining({ reason: "UNMAPPED_EVENT_TYPE" }) }),
    ]);
    expect(payload.resolveOffset).toHaveBeenCalledWith("0");
  });

  it("rethrows a landing failure without resolving affected offsets", async () => {
    const deps = makeDeps();
    (deps.warehouse.insertEvents as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("bigquery down"));
    const payload = makeBatch([envelope("evt-1"), envelope("evt-2")]);

    await expect(handleBatch(payload, deps, 500)).rejects.toThrow("bigquery down");
    expect(payload.resolveOffset).not.toHaveBeenCalled();
    expect(deps.stats.jobsFailed).toBe(2);
  });

  it("counts permanently rejected BigQuery rows as quarantined", async () => {
    const deps = makeDeps();
    (deps.warehouse.insertEvents as ReturnType<typeof vi.fn>).mockResolvedValue({ quarantined: 1 });
    const payload = makeBatch([envelope("evt-1"), envelope("evt-2")]);

    await handleBatch(payload, deps, 500);

    expect(deps.stats.jobsSucceeded).toBe(1);
    expect(deps.stats.jobsQuarantined).toBe(1);
    expect(payload.resolveOffset).toHaveBeenCalledTimes(2);
  });

  it("rethrows a quarantine failure so the poison record is not lost", async () => {
    const deps = makeDeps();
    (deps.warehouse.insertDeadLetters as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("quarantine down"));
    const payload = makeBatch(["not-json"]);

    await expect(handleBatch(payload, deps, 500)).rejects.toThrow("quarantine down");
    expect(payload.resolveOffset).not.toHaveBeenCalled();
  });

  it("quarantines events with malformed timestamps instead of landing them", async () => {
    const deps = makeDeps();
    const payload = makeBatch([
      envelope("evt-bad-ts", { occurredAt: "not-a-date" }),
      envelope("evt-good"),
    ]);

    await handleBatch(payload, deps, 500);

    expect(deps.warehouse.insertDeadLetters).toHaveBeenCalledWith([
      expect.objectContaining({ row: expect.objectContaining({ reason: "INVALID_EVENT_ENVELOPE" }) }),
    ]);
    expect(deps.warehouse.insertEvents).toHaveBeenCalledOnce();
    expect(deps.stats.jobsQuarantined).toBe(1);
    expect(deps.stats.jobsSucceeded).toBe(1);
  });

  it("accepts v2 envelopes with valid ingestedAt and producer", async () => {
    const deps = makeDeps();
    const payload = makeBatch([
      envelope("evt-v2", {
        eventVersion: "2",
        occurredAt: "2026-01-01T00:00:00.000Z",
        ingestedAt: "2026-01-01T00:00:00.050Z",
        producer: "backend",
      }),
    ]);

    await handleBatch(payload, deps, 500);

    expect(deps.warehouse.insertEvents).toHaveBeenCalledOnce();
    expect(deps.warehouse.insertDeadLetters).not.toHaveBeenCalled();
    expect(deps.stats.jobsSucceeded).toBe(1);
  });

  it("splits large batches by byte size to stay under BigQuery limits", async () => {
    const deps = makeDeps();
    const bigPayload = { postId: "post-big", authorId: "author-1", blob: "x".repeat(600 * 1024) };
    const payload = makeBatch([
      envelope("evt-big-1", { payload: bigPayload }),
      envelope("evt-big-2", { payload: bigPayload }),
    ]);

    await handleBatch(payload, deps, 500);

    // Two ~600 KiB rows must not land in a single BigQuery call.
    expect(deps.warehouse.insertEvents).toHaveBeenCalledTimes(2);
    expect(payload.resolveOffset).toHaveBeenCalledTimes(2);
    expect(deps.stats.jobsSucceeded).toBe(2);
  });

  it("lands typed session/request/experiment envelope fields with payload fallback", async () => {
    const deps = makeDeps();
    const payload = makeBatch([
      envelope("evt-typed", {
        eventVersion: "2",
        occurredAt: "2026-01-01T00:00:00.000Z",
        ingestedAt: "2026-01-01T00:00:00.050Z",
        producer: "backend",
        sessionId: "session-9",
        requestId: "request-8",
        experimentId: "feed-quality-1",
        experimentVariant: "baseline",
      }),
    ]);

    await handleBatch(payload, deps, 500);

    expect(deps.warehouse.insertEvents).toHaveBeenCalledWith("raw_post_created", [
      expect.objectContaining({
        row: expect.objectContaining({
          sessionId: "session-9",
          requestId: "request-8",
          experimentId: "feed-quality-1",
          experimentVariant: "baseline",
        }),
      }),
    ]);
  });

  it("archives landed envelopes best-effort without blocking offsets", async () => {
    const deps = makeDeps();
    const archive = { writeBatch: vi.fn().mockResolvedValue(undefined) };
    const payload = makeBatch([envelope("evt-1")]);

    await handleBatch(payload, { ...deps, archive }, 500);

    expect(archive.writeBatch).toHaveBeenCalledOnce();
    expect(payload.resolveOffset).toHaveBeenCalledWith("0");
  });

  it("still commits BigQuery offsets when the archive write fails", async () => {
    const deps = makeDeps();
    const archive = { writeBatch: vi.fn().mockRejectedValue(new Error("s3 down")) };
    const payload = makeBatch([envelope("evt-1")]);

    await handleBatch(payload, { ...deps, archive }, 500);

    expect(payload.resolveOffset).toHaveBeenCalledWith("0");
    expect(deps.stats.jobsSucceeded).toBe(1);
  });
});
