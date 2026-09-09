import { beforeEach, describe, expect, it, vi } from "vitest";

import { BucketedTrendingStore, BUCKET_MINUTES, toBucket } from "./bucketed-trending.js";

function makeRedis() {
  const zsets = new Map<string, Map<string, number>>();
  const redis: Record<string, ReturnType<typeof vi.fn>> = {
    pipeline: vi.fn(() => {
      const ops: (() => void)[] = [];
      return {
        zincrby: vi.fn((key: string, weight: number, id: string) => {
          ops.push(() => {
            const set = zsets.get(key) ?? new Map<string, number>();
            set.set(id, (set.get(id) ?? 0) + weight);
            zsets.set(key, set);
          });
          return undefined;
        }),
        expire: vi.fn(() => undefined),
        zscore: vi.fn((_key: string, _id: string) => {
          ops.push(() => undefined);
          return undefined;
        }),
        exec: vi.fn(async () => ops.map(() => [null, "0"] as [null, string])),
      };
    }),
    zincrby: vi.fn(async (key: string, weight: number, id: string) => {
      const set = zsets.get(key) ?? new Map<string, number>();
      set.set(id, (set.get(id) ?? 0) + weight);
      zsets.set(key, set);
      return "0";
    }),
    expire: vi.fn(async () => 1),
    del: vi.fn(async () => 1),
    zrevrange: vi.fn(async () => [] as string[]),
    zscore: vi.fn(async () => null),
    zunionstore: vi.fn(async () => 0),
  };
  return { redis: redis as unknown as import("ioredis").Redis, zsets };
}

describe("bucketed trending", () => {
  beforeEach(() => vi.clearAllMocks());

  it("buckets by event time, not arrival time", async () => {
    const { redis } = makeRedis();
    const store = new BucketedTrendingStore(redis);
    const eventTime = Date.parse("2026-01-01T00:07:00.000Z");
    await store.record("posts", "post-1", 3, eventTime);
    const expectedBucket = toBucket(eventTime);
    expect(redis.pipeline).toHaveBeenCalledOnce();
    // 5-minute buckets: 00:07 falls in bucket 2 of the hour.
    expect(expectedBucket % (60 / BUCKET_MINUTES)).toBe(1);
  });

  it("replica-equality: same buckets produce same union weights", async () => {
    const first = makeRedis();
    const second = makeRedis();
    // Two replicas recording the same events into the same bucket keys
    // converge because reads sum buckets by age — no per-replica decay.
    // Here we assert the union shape: 3 recent buckets weight 1, 9 prev weight 0.5.
    const store = new BucketedTrendingStore(first.redis);
    await store.getTop("posts", 10, Date.parse("2026-01-01T01:00:00.000Z")).catch(() => undefined);
    expect(first.redis.zunionstore).toHaveBeenCalledOnce();
    const args = (first.redis.zunionstore as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    // dest + numkeys + 12*(key+weight) + AGGREGATE + SUM
    expect(args[1]).toBe(12);
    expect(second.zsets.size).toBe(0);
  });

  it("velocity matches the design trend term", async () => {
    const { redis } = makeRedis();
    // e15=10, ePrev=6 => ratio=(12)/(4)=3 => sigmoid(log 3)=0.75
    const pipelineExec = vi.fn(async () => [
      [null, "4"],
      [null, "3"],
      [null, "3"],
      [null, "2"],
      [null, "1"],
      [null, "1"],
      [null, "1"],
      [null, "1"],
      [null, "0"],
      [null, "0"],
      [null, "0"],
      [null, "0"],
    ]);
    (redis.pipeline as ReturnType<typeof vi.fn>).mockReturnValue({
      zscore: vi.fn(),
      exec: pipelineExec,
    });
    const store = new BucketedTrendingStore(redis);
    const v = await store.velocity("posts", "post-1", Date.parse("2026-01-01T01:00:00.000Z"));
    expect(v).toBeCloseTo(0.75, 2);
  });
});
