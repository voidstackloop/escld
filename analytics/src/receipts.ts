import type { Redis } from "ioredis";

/** Replay-safe per-projection receipts: (eventId, projectionVersion, entityKey).
 * A bounded Lua script records the receipt and returns whether this worker
 * should apply the contribution. Each projection owns its receipt so a crash
 * between user and post updates is safe — redelivery finishes the missing side.
 * Receipts live 8 days, longer than the 7-day Kafka retention; replays older
 * than that rebuild into a new feature generation instead of live state. */
export const RECEIPT_TTL_SECONDS = 8 * 24 * 60 * 60;
export const PROJECTION_VERSION = 1;

const CLAIM_SCRIPT = `
if redis.call("EXISTS", KEYS[1]) == 1 then
  return 0
end
redis.call("HSET", KEYS[1], "projectionVersion", ARGV[1], "entityKey", ARGV[2], "appliedAt", ARGV[3])
redis.call("EXPIRE", KEYS[1], ARGV[4])
return 1
`;

export class ReceiptStore {
  constructor(private readonly redis: Redis, private readonly keyPrefix = "receipt:v1") {}

  receiptKey(eventId: string): string {
    return `${this.keyPrefix}:${eventId}`;
  }

  /** Returns true only when this worker newly claimed the event. */
  async tryClaim(eventId: string, entityKey: string): Promise<boolean> {
    const result = (await this.redis.eval(
      CLAIM_SCRIPT,
      1,
      this.receiptKey(eventId),
      String(PROJECTION_VERSION),
      entityKey,
      new Date().toISOString(),
      String(RECEIPT_TTL_SECONDS)
    )) as number;
    return result === 1;
  }
}
