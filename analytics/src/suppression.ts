import type { Redis } from "ioredis";

/** Deletion suppression ledger consulted by relays and replay jobs so old
 * events cannot recreate deleted records. Actor IDs and owned entity IDs are
 * added on deletion request/completion before derived state is removed.
 * Retained through the maximum restore/replay horizon (13 months default);
 * backup retention must not exceed that horizon without extending it. */
export class SuppressionStore {
  constructor(private readonly redis: Redis) {}

  async suppressUser(userId: string): Promise<void> {
    await this.redis.sadd("suppression:users", userId);
  }

  async suppressPost(postId: string): Promise<void> {
    await this.redis.sadd("suppression:posts", postId);
  }

  async isUserSuppressed(userId: string): Promise<boolean> {
    return (await this.redis.sismember("suppression:users", userId)) === 1;
  }

  async isPostSuppressed(postId: string): Promise<boolean> {
    return (await this.redis.sismember("suppression:posts", postId)) === 1;
  }
}
