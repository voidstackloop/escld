import { beforeEach, describe, expect, it, vi } from "vitest";

import { FeatureMaterializer } from "./features.js";

function makeRedis() {
  const zsets = new Map<string, Map<string, number>>();
  const sets = new Map<string, Set<string>>();
  const redis = {
    pipeline: vi.fn(() => {
      const ops: (() => void)[] = [];
      return {
        zincrby: vi.fn((key: string, weight: number, member: string) => {
          ops.push(() => {
            const set = zsets.get(key) ?? new Map<string, number>();
            set.set(member, (set.get(member) ?? 0) + weight);
            zsets.set(key, set);
          });
        }),
        sadd: vi.fn((key: string, member: string) => {
          ops.push(() => {
            const set = sets.get(key) ?? new Set<string>();
            set.add(member);
            sets.set(key, set);
          });
        }),
        expire: vi.fn(() => undefined),
        exec: vi.fn(async () => {
          ops.forEach((op) => op());
          return [];
        }),
      };
    }),
    zcard: vi.fn(async (key: string) => zsets.get(key)?.size ?? 0),
    zremrangebyrank: vi.fn(async () => 0),
    zscore: vi.fn(async (key: string, member: string) => {
      const v = zsets.get(key)?.get(member);
      return v === undefined ? null : String(v);
    }),
    sismember: vi.fn(async (key: string, member: string) => (sets.get(key)?.has(member) ? 1 : 0)),
    scard: vi.fn(async (key: string) => sets.get(key)?.size ?? 0),
    spop: vi.fn(async () => undefined),
  };
  return { redis: redis as unknown as import("ioredis").Redis, zsets, sets };
}

describe("FeatureMaterializer", () => {
  beforeEach(() => vi.clearAllMocks());

  it("caps positive evidence at 5 per post/session", async () => {
    const { redis, zsets } = makeRedis();
    const features = new FeatureMaterializer(redis);
    await features.recordPositive("viewer-1", "author-1", ["rust"], 99);
    expect(zsets.get("features:author:pos:viewer-1")?.get("author-1")).toBe(5);
  });

  it("keeps hide evidence separate from positive affinity", async () => {
    const { redis, zsets } = makeRedis();
    const features = new FeatureMaterializer(redis);
    await features.recordPositive("viewer-1", "author-1", [], 2);
    await features.recordHide("viewer-1", "author-1", []);
    expect(zsets.get("features:author:pos:viewer-1")?.get("author-1")).toBe(2);
    expect(zsets.get("features:author:neg:viewer-1")?.get("author-1")).toBe(5);
  });

  it("tracks qualified seen history for suppression of repeats", async () => {
    const { redis } = makeRedis();
    const features = new FeatureMaterializer(redis);
    await features.recordSeen("viewer-1", "post-1");
    expect(await features.hasSeen("viewer-1", "post-1")).toBe(true);
    expect(await features.hasSeen("viewer-1", "post-2")).toBe(false);
  });
});
