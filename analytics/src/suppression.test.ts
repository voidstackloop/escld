import { beforeEach, describe, expect, it, vi } from "vitest";

import { SuppressionStore } from "./suppression.js";

function makeRedis() {
  const sets = new Map<string, Set<string>>();
  const redis = {
    sadd: vi.fn(async (key: string, member: string) => {
      const set = sets.get(key) ?? new Set<string>();
      set.add(member);
      sets.set(key, set);
      return 1;
    }),
    sismember: vi.fn(async (key: string, member: string) => (sets.get(key)?.has(member) ? 1 : 0)),
  };
  return { redis: redis as unknown as import("ioredis").Redis, sets };
}

describe("SuppressionStore", () => {
  beforeEach(() => vi.clearAllMocks());

  it("suppresses users and checks suppression status correctly", async () => {
    const { redis } = makeRedis();
    const suppression = new SuppressionStore(redis);

    expect(await suppression.isUserSuppressed("user-100")).toBe(false);

    await suppression.suppressUser("user-100");

    expect(await suppression.isUserSuppressed("user-100")).toBe(true);
    expect(await suppression.isUserSuppressed("user-200")).toBe(false);
  });

  it("suppresses posts and checks suppression status correctly", async () => {
    const { redis } = makeRedis();
    const suppression = new SuppressionStore(redis);

    expect(await suppression.isPostSuppressed("post-500")).toBe(false);

    await suppression.suppressPost("post-500");

    expect(await suppression.isPostSuppressed("post-500")).toBe(true);
    expect(await suppression.isPostSuppressed("post-600")).toBe(false);
  });
});
