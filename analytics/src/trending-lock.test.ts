import { describe, expect, it, vi } from "vitest";

import { acquireDecayLock, releaseDecayLock } from "./trending-lock.js";

function makeRedis() {
  const store = new Map<string, string>();
  const redis: Record<string, ReturnType<typeof vi.fn>> = {
    set: vi.fn(async (key: string, value: string, ..._opts: unknown[]) => {
      if (store.has(key)) return null;
      store.set(key, value);
      return "OK";
    }),
    eval: vi.fn(async (_script: string, _numKeys: number, key: string, token: string) => {
      if (store.get(key) === token) {
        store.delete(key);
        return 1;
      }
      return 0;
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
  };
  return { redis: redis as unknown as import("ioredis").Redis, store };
}

describe("trending decay lock", () => {
  it("acquires when the key is absent", async () => {
    const { redis } = makeRedis();
    const token = await acquireDecayLock(redis, "lock:decay", 60_000);
    expect(token).not.toBeNull();
    expect(redis.set).toHaveBeenCalledWith("lock:decay", expect.any(String), "PX", 60_000, "NX");
  });

  it("fails to acquire while another replica holds the lock", async () => {
    const { redis } = makeRedis();
    const first = await acquireDecayLock(redis, "lock:decay", 60_000);
    const second = await acquireDecayLock(redis, "lock:decay", 60_000);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("releases only when the owner token matches (compare-and-delete)", async () => {
    const { redis, store } = makeRedis();
    const token = await acquireDecayLock(redis, "lock:decay", 60_000);
    expect(token).not.toBeNull();

    // A different (stale) token must not be able to release someone else's lock.
    await releaseDecayLock(redis, "lock:decay", "not-the-real-owner");
    expect(store.has("lock:decay")).toBe(true);

    await releaseDecayLock(redis, "lock:decay", token as string);
    expect(store.has("lock:decay")).toBe(false);
  });

  it("lets a new replica acquire the lock once it's released", async () => {
    const { redis } = makeRedis();
    const token = await acquireDecayLock(redis, "lock:decay", 60_000);
    await releaseDecayLock(redis, "lock:decay", token as string);
    const reacquired = await acquireDecayLock(redis, "lock:decay", 60_000);
    expect(reacquired).not.toBeNull();
  });
});
