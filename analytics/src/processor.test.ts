import { beforeEach, describe, expect, it, vi } from "vitest";

import { AnalyticsProcessor } from "./processor.js";

function envelope(id: string, overrides: Record<string, unknown> = {}) {
  return {
    eventId: id,
    eventType: "post.liked",
    eventVersion: "2",
    occurredAt: "2026-01-01T00:00:00.000Z",
    ingestedAt: "2026-01-01T00:00:00.050Z",
    producer: "backend",
    actorId: "user-1",
    payload: { postId: "post-1" },
    ...overrides,
  };
}

function makeBatch(values: unknown[]) {
  const messages = values.map((value, index) => ({
    value: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)),
    offset: String(index),
    headers: {},
  }));
  return {
    batch: { topic: "domain.events.v2", partition: 0, messages },
    resolveOffset: vi.fn(),
    heartbeat: vi.fn().mockResolvedValue(undefined),
    commitOffsetsIfNecessary: vi.fn().mockResolvedValue(undefined),
    isRunning: () => true,
    isStale: () => false,
  } as unknown as import("kafkajs").EachBatchPayload;
}

function makeDeps() {
  const claimed = new Set<string>();
  const redis = {
    eval: vi.fn(async (_script: string, _n: number, key: string) => {
      if (claimed.has(key)) return 0;
      claimed.add(key);
      return 1;
    }),
    sismember: vi.fn(async () => 0),
    pipeline: vi.fn(() => ({
      zincrby: vi.fn(),
      sadd: vi.fn(),
      expire: vi.fn(),
      del: vi.fn(),
      exec: vi.fn(async () => []),
    })),
    zcard: vi.fn(async () => 0),
    zremrangebyrank: vi.fn(async () => 0),
    scard: vi.fn(async () => 0),
    spop: vi.fn(async () => undefined),
  };
  const trending = {
    record: vi.fn().mockResolvedValue(undefined),
    getTop: vi.fn(),
  };
  return { redis, trending, claimed };
}

describe("AnalyticsProcessor", () => {
  beforeEach(() => vi.clearAllMocks());

  it("applies each event once; duplicates via receipt are no-ops", async () => {
    const { redis, trending } = makeDeps();
    const processor = new AnalyticsProcessor(
      {} as never,
      redis as never,
      { groupId: "test", topics: ["domain.events.v2"] },
      trending as never,
      new (await import("./receipts.js")).ReceiptStore(redis as never)
    );
    const batch = makeBatch([envelope("evt-1"), envelope("evt-1")]);
    await processor.handleBatch(batch);
    expect(trending.record).toHaveBeenCalledTimes(1);
    expect(batch.resolveOffset).toHaveBeenCalledTimes(2);
  });

  it("quarantines invalid envelopes but commits their offsets", async () => {
    const { redis, trending } = makeDeps();
    const processor = new AnalyticsProcessor(
      {} as never,
      redis as never,
      { groupId: "test", topics: ["domain.events.v2"] },
      trending as never,
      new (await import("./receipts.js")).ReceiptStore(redis as never)
    );
    const batch = makeBatch(["not-json", envelope("evt-2")]);
    await processor.handleBatch(batch);
    expect(trending.record).toHaveBeenCalledTimes(1);
    expect(batch.resolveOffset).toHaveBeenCalledTimes(2);
  });

  it("suppresses deleted users without applying contributions", async () => {
    const { trending } = makeDeps();
    const redis = {
      eval: vi.fn(async () => 1),
      sismember: vi.fn(async (key: string) => (key === "suppression:users" ? 1 : 0)),
      pipeline: vi.fn(() => ({
        zincrby: vi.fn(),
        sadd: vi.fn(),
        expire: vi.fn(),
        exec: vi.fn(async () => []),
      })),
      zcard: vi.fn(async () => 0),
      zremrangebyrank: vi.fn(async () => 0),
      scard: vi.fn(async () => 0),
      spop: vi.fn(async () => undefined),
    };
    const processor = new AnalyticsProcessor(
      {} as never,
      redis as never,
      { groupId: "test", topics: ["domain.events.v2"] },
      trending as never,
      new (await import("./receipts.js")).ReceiptStore(redis as never)
    );
    const batch = makeBatch([envelope("evt-9")]);
    await processor.handleBatch(batch);
    expect(trending.record).not.toHaveBeenCalled();
    expect(batch.resolveOffset).toHaveBeenCalledWith("0");
  });

  it("replay rebuild equals clean run: same eventIds in new store apply once each", async () => {
    const first = makeDeps();
    const p1 = new AnalyticsProcessor(
      {} as never,
      first.redis as never,
      { groupId: "test", topics: ["t"] },
      first.trending as never,
      new (await import("./receipts.js")).ReceiptStore(first.redis as never)
    );
    await p1.handleBatch(makeBatch([envelope("evt-a"), envelope("evt-b")]));
    expect(first.trending.record).toHaveBeenCalledTimes(2);

    // Fresh store replaying the same batch (e.g., new feature generation
    // with empty receipts) applies the same two contributions — deterministic.
    const second = makeDeps();
    const p2 = new AnalyticsProcessor(
      {} as never,
      second.redis as never,
      { groupId: "test", topics: ["t"] },
      second.trending as never,
      new (await import("./receipts.js")).ReceiptStore(second.redis as never)
    );
    await p2.handleBatch(makeBatch([envelope("evt-a"), envelope("evt-b")]));
    expect(second.trending.record).toHaveBeenCalledTimes(2);
  });

  it("applies deletion suppression before derived-state removal", async () => {
    const { redis, trending } = makeDeps();
    const sadd = vi.fn(async () => 1);
    (redis as unknown as Record<string, unknown>).sadd = sadd;
    const processor = new AnalyticsProcessor(
      {} as never,
      redis as never,
      { groupId: "test", topics: ["privacy.events.v2"] },
      trending as never,
      new (await import("./receipts.js")).ReceiptStore(redis as never)
    );
    const deletion = envelope("evt-del", {
      eventType: "user.deletion_completed",
      actorId: "user-gone",
      payload: { userId: "user-gone", ownedPostIds: ["post-1", "post-2"] },
    });
    const batch = makeBatch([deletion]);
    await processor.handleBatch(batch);
    expect(sadd).toHaveBeenCalledWith("suppression:users", "user-gone");
    expect(trending.record).not.toHaveBeenCalled();
    expect(batch.resolveOffset).toHaveBeenCalledWith("0");
  });
});
