import { randomUUID } from "node:crypto";

import type { Redis } from "ioredis";

const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`;

/**
 * A short-lived, self-healing lock so only one of N autoscaled `analytics`
 * replicas runs a given decay pass per cron tick — without this, every
 * replica runs its own independent decay.ts pass against the same shared
 * Redis sorted set, and trending scores decay at a rate that silently
 * multiplies with replica count (see index.ts's legacy Pub/Sub branch).
 *
 * Deliberately NOT a static "one replica is the leader" env var: if that one
 * task dies or ECS bin-packs differently, decay silently stops forever with
 * nothing else picking it up. This lock expires and is re-acquirable by
 * whichever replica's tick wins next, so a crashed holder self-heals within
 * one cron interval instead of needing an operator to notice.
 *
 * `ttlMs` must comfortably cover a realistic decay-pass duration, not just
 * the moment of acquisition — TrendingStore.decay() is a ZSCAN-batched loop
 * (multiple round trips), not one atomic operation, so the lock has to stay
 * held for the whole pass.
 */
export async function acquireDecayLock(redis: Redis, key: string, ttlMs: number): Promise<string | null> {
  const ownerToken = randomUUID();
  const result = await redis.set(key, ownerToken, "PX", ttlMs, "NX");
  return result === "OK" ? ownerToken : null;
}

/**
 * Compare-and-delete, not a bare DEL — a bare DEL would let a replica that
 * finishes its pass late (after its own lock TTL already expired and a
 * different replica legitimately re-acquired the key) delete that other
 * replica's still-valid lock out from under it.
 */
export async function releaseDecayLock(redis: Redis, key: string, ownerToken: string): Promise<void> {
  await redis.eval(RELEASE_SCRIPT, 1, key, ownerToken);
}
